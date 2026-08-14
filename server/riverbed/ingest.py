"""Wikimedia EventStreams client.

Connects to the public `recentchange` stream -- every edit to every Wikimedia
wiki on earth, roughly 30-50 events per second -- and normalizes each event into
the flat `edits` row the query engine expects.

The reliability work here is the unglamorous part that makes the demo link stay
up: the upstream connection *will* drop, sometimes several times an hour. The
client reconnects with exponential backoff and jitter, resumes from the last
event id so the gap is bounded, and treats a silent socket (open but delivering
nothing) as a failure rather than waiting forever on a dead connection.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

log = logging.getLogger("riverbed.ingest")

STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

#: Wikimedia asks for a descriptive User-Agent identifying the client.
USER_AGENT = "Riverbed/1.0 (streaming SQL demo; https://github.com/) python-httpx"

#: If no event arrives in this long, assume the connection is wedged and
#: reconnect. The real stream never goes this quiet.
SILENCE_TIMEOUT = 45.0

MAX_BACKOFF = 30.0

#: Event types the UI cares about. `categorize` events are bookkeeping noise
#: that would roughly double volume without adding anything a person wants to
#: see, so they are dropped at ingest rather than filtered in every query.
KEPT_TYPES = {"edit", "new", "log"}


@dataclass
class IngestStats:
    connected: bool = False
    events_received: int = 0
    events_kept: int = 0
    parse_errors: int = 0
    reconnects: int = 0
    last_error: str | None = None
    connected_since: float | None = None
    last_event_at: float | None = None
    lag_samples: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        lag = sorted(self.lag_samples[-200:])
        return {
            "connected": self.connected,
            "events_received": self.events_received,
            "events_kept": self.events_kept,
            "parse_errors": self.parse_errors,
            "reconnects": self.reconnects,
            "last_error": self.last_error,
            "uptime_seconds": (
                round(time.time() - self.connected_since, 1) if self.connected_since else 0
            ),
            "last_event_age": (
                round(time.time() - self.last_event_at, 2) if self.last_event_at else None
            ),
            # How far behind the wiki clock we are: the honest measure of
            # whether the pipeline is keeping up.
            "median_lag_seconds": round(lag[len(lag) // 2], 2) if lag else None,
        }


def parse_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize one recentchange event into an `edits` row.

    Returns None for events that should be dropped. Upstream fields are
    inconsistently present across wikis, so every access is defensive -- a
    missing `length` on one small wiki must not stall the whole pipeline.
    """
    etype = raw.get("type")
    if etype not in KEPT_TYPES:
        return None

    server = raw.get("server_name") or ""
    if not server:
        return None

    # 'en.wikipedia.org' -> lang 'en', project 'wikipedia'.
    # Sites like 'commons.wikimedia.org' or 'www.wikidata.org' have no language
    # component, so they are labelled by project with lang '-'.
    parts = server.split(".")
    if len(parts) >= 3 and parts[0] not in ("www", "commons", "meta", "species", "incubator"):
        lang, project = parts[0], parts[1]
    else:
        lang = "-"
        project = parts[1] if len(parts) >= 2 else server

    length = raw.get("length") or {}
    old_len = length.get("old") or 0
    new_len = length.get("new") or 0
    # A page creation has no old length; the whole page counts as added.
    delta = new_len - old_len if old_len else new_len

    ts = raw.get("timestamp")
    if isinstance(ts, (int, float)):
        event_time = float(ts)
    else:
        try:
            event_time = datetime.fromisoformat(
                str(raw.get("meta", {}).get("dt", "")).replace("Z", "+00:00")
            ).timestamp()
        except (ValueError, TypeError):
            event_time = time.time()

    user = raw.get("user") or ""

    return {
        "ts": event_time,
        "wiki": server,
        "lang": lang,
        "project": project,
        "type": etype,
        "title": raw.get("title") or "",
        "user": user,
        "is_bot": bool(raw.get("bot")),
        # The stream has no explicit anonymous flag; MediaWiki reports logged-out
        # edits with the IP address as the username.
        "is_anon": _looks_like_ip(user),
        "is_minor": bool(raw.get("minor")),
        "namespace": int(raw.get("namespace") or 0),
        "delta": int(delta),
        "new_len": int(new_len),
        "comment": (raw.get("comment") or "")[:280],
        "uri": (raw.get("meta") or {}).get("uri") or "",
    }


def _looks_like_ip(user: str) -> bool:
    if not user:
        return False
    if ":" in user and all(c in "0123456789abcdefABCDEF:" for c in user):
        return True  # IPv6
    parts = user.split(".")
    return len(parts) == 4 and all(p.isdigit() and len(p) <= 3 for p in parts)


class FirehoseClient:
    """Owns the upstream connection and pushes normalized rows to a sink."""

    def __init__(
        self,
        sink: Callable[[list[dict]], Any],
        url: str = STREAM_URL,
        flush_interval: float = 0.25,
        on_event: Callable[[dict], Awaitable[None]] | None = None,
    ):
        self.sink = sink
        self.url = url
        self.flush_interval = flush_interval
        self.on_event = on_event
        self.stats = IngestStats()
        self._last_event_id: str | None = None
        self._buffer: list[dict] = []
        self._stop = asyncio.Event()

    async def run(self) -> None:
        """Connect and stream forever, reconnecting on any failure."""
        attempt = 0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                attempt = 0  # A clean run resets the backoff ladder.
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - must survive anything upstream does
                self.stats.connected = False
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
                self.stats.reconnects += 1
                attempt += 1
                # Exponential backoff with full jitter. Jitter matters: without
                # it, every client restarted by an upstream blip retries in
                # lockstep and hammers the recovering server.
                delay = min(MAX_BACKOFF, 2 ** min(attempt, 5)) * (0.5 + random.random() / 2)
                log.warning("stream failed (%s); reconnecting in %.1fs", exc, delay)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass

    async def _connect_once(self) -> None:
        headers = {"User-Agent": USER_AGENT, "Accept": "text/event-stream"}
        if self._last_event_id:
            # Resume where we left off so a reconnect loses seconds, not minutes.
            headers["Last-Event-ID"] = self._last_event_id

        timeout = httpx.Timeout(connect=15.0, read=SILENCE_TIMEOUT, write=15.0, pool=15.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", self.url, headers=headers) as response:
                response.raise_for_status()
                self.stats.connected = True
                self.stats.connected_since = time.time()
                self.stats.last_error = None
                log.info("connected to %s", self.url)

                flush_task = asyncio.create_task(self._flush_loop())
                try:
                    await self._read_stream(response)
                finally:
                    flush_task.cancel()
                    self.stats.connected = False
                    await self._flush()

    async def _read_stream(self, response: httpx.Response) -> None:
        """Parse the SSE framing: `id:` / `event:` / `data:` lines, blank-separated."""
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if self._stop.is_set():
                return

            if line.startswith(":"):
                continue  # Server keepalive comment.

            if line == "":
                if data_lines:
                    self._handle_payload("\n".join(data_lines))
                    data_lines = []
                continue

            field, _, value = line.partition(":")
            value = value[1:] if value.startswith(" ") else value

            if field == "data":
                data_lines.append(value)
            elif field == "id":
                self._last_event_id = value

    def _handle_payload(self, payload: str) -> None:
        self.stats.events_received += 1
        try:
            raw = json.loads(payload)
        except json.JSONDecodeError:
            self.stats.parse_errors += 1
            return

        try:
            row = parse_event(raw)
        except Exception:  # noqa: BLE001 - one malformed event must not kill the stream
            self.stats.parse_errors += 1
            return

        if row is None:
            return

        self.stats.events_kept += 1
        self.stats.last_event_at = time.time()
        self.stats.lag_samples.append(max(0.0, time.time() - row["ts"]))
        if len(self.stats.lag_samples) > 500:
            del self.stats.lag_samples[:250]

        self._buffer.append(row)

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self.flush_interval)
            await self._flush()

    async def _flush(self) -> None:
        """Hand buffered rows to the sink in batches.

        Batching rather than appending per event keeps the store's lock
        acquisitions to a few per second instead of ~40, and gives the event
        loop long uninterrupted stretches to serve WebSocket clients.
        """
        if not self._buffer:
            return
        batch, self._buffer = self._buffer, []
        try:
            self.sink(batch)
        except Exception:  # noqa: BLE001
            log.exception("sink failed for %d rows", len(batch))
            return

        if self.on_event is not None:
            for row in batch:
                await self.on_event(row)

    def stop(self) -> None:
        self._stop.set()
