"""In-memory columnar ring buffer, plus sketch-backed long-horizon rollups.

Why not a database: every query here is a full scan over a bounded, recent
time range with no point lookups and no joins. An embedded database would add
serialization, a query planner fighting ours, and disk I/O to a workload that
fits comfortably in RAM. A ring buffer of parallel column arrays is both faster
and much easier to reason about for continuous re-evaluation.

Why columnar: a typical query touches two or three of fifteen columns. Column
arrays mean those scans walk contiguous memory instead of skipping through
whole event objects, and Python's list-of-primitives is dramatically cheaper to
iterate than a list of dicts or dataclasses.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from .schema import COLUMNS, ColType
from .sketches import CountMinSketch, HyperLogLog, TDigest

#: Raw retention. Sized so the whole buffer stays a few hundred MB at the
#: firehose's real rate (~40 events/sec -> ~72k rows per 30 min).
DEFAULT_WINDOW_SECONDS = 30 * 60

#: Hard cap so a traffic spike cannot exhaust memory. Whichever bound is hit
#: first wins.
DEFAULT_MAX_ROWS = 250_000


@dataclass
class RollupBucket:
    """One minute of pre-aggregated history, for horizons past the raw buffer."""

    minute: int
    events: int = 0
    bot_events: int = 0
    anon_events: int = 0
    bytes_added: int = 0
    bytes_removed: int = 0
    users: HyperLogLog = field(default_factory=lambda: HyperLogLog(12))
    titles: CountMinSketch = field(default_factory=lambda: CountMinSketch(width=1024, depth=4, k=40))
    deltas: TDigest = field(default_factory=TDigest)
    by_lang: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "minute": self.minute,
            "events": self.events,
            "bot_events": self.bot_events,
            "anon_events": self.anon_events,
            "bytes_added": self.bytes_added,
            "bytes_removed": self.bytes_removed,
            "distinct_users": self.users.count(),
            "p50_delta": round(self.deltas.quantile(0.5), 1),
            "p99_delta": round(self.deltas.quantile(0.99), 1),
        }


class EventStore:
    """Thread-safe columnar ring buffer.

    Locking is coarse -- one lock around append and snapshot -- because the
    contention pattern is one writer (the ingest task) and short reads from the
    query loop. Finer-grained locking would buy nothing and risks tearing a
    scan across an eviction.
    """

    def __init__(
        self,
        window_seconds: int = DEFAULT_WINDOW_SECONDS,
        max_rows: int = DEFAULT_MAX_ROWS,
        rollup_minutes: int = 24 * 60,
    ):
        self.window_seconds = window_seconds
        self.max_rows = max_rows
        self.rollup_minutes = rollup_minutes

        self._lock = threading.RLock()
        self.columns: dict[str, list[Any]] = {c.name: [] for c in COLUMNS}
        self._col_types = {c.name: c.type for c in COLUMNS}

        #: Monotonically increasing id of the oldest retained row. Lets the API
        #: tell a client "you missed rows" instead of silently skipping.
        self.base_offset = 0
        self.total_ingested = 0

        self.rollups: dict[int, RollupBucket] = {}
        self.started_at = time.time()
        self.last_event_at: float | None = None

    # -- writing ------------------------------------------------------------

    def append(self, row: dict[str, Any]) -> None:
        with self._lock:
            for name, col in self.columns.items():
                col.append(row.get(name, _zero(self._col_types[name])))
            self.total_ingested += 1
            self.last_event_at = time.time()
            self._update_rollup(row)
            self._evict()

    def append_many(self, rows: Iterable[dict[str, Any]]) -> int:
        count = 0
        with self._lock:
            for row in rows:
                for name, col in self.columns.items():
                    col.append(row.get(name, _zero(self._col_types[name])))
                self._update_rollup(row)
                count += 1
            self.total_ingested += count
            if count:
                self.last_event_at = time.time()
            self._evict()
        return count

    def _update_rollup(self, row: dict[str, Any]) -> None:
        minute = int(row.get("ts", time.time())) // 60
        bucket = self.rollups.get(minute)
        if bucket is None:
            bucket = self.rollups[minute] = RollupBucket(minute=minute)

        bucket.events += 1
        if row.get("is_bot"):
            bucket.bot_events += 1
        if row.get("is_anon"):
            bucket.anon_events += 1

        delta = row.get("delta", 0) or 0
        if delta > 0:
            bucket.bytes_added += delta
        else:
            bucket.bytes_removed += -delta
        bucket.deltas.add(float(delta))

        if user := row.get("user"):
            bucket.users.add(user)
        if title := row.get("title"):
            bucket.titles.add(title)
        if lang := row.get("lang"):
            bucket.by_lang[lang] = bucket.by_lang.get(lang, 0) + 1

        if len(self.rollups) > self.rollup_minutes:
            for stale in sorted(self.rollups)[: len(self.rollups) - self.rollup_minutes]:
                del self.rollups[stale]

    def _evict(self) -> None:
        """Drop rows that fell out of the retention window or the row cap.

        Eviction is a single slice per column rather than repeated pops: slicing
        is one C-level memmove, while popping from the front of a Python list is
        O(n) *per row* and would dominate the ingest path under load.
        """
        n = len(self.columns["ts"])
        if n == 0:
            return

        cutoff = time.time() - self.window_seconds
        ts = self.columns["ts"]

        # Rows arrive in near-timestamp order, so a linear scan from the front
        # is effectively O(evicted) rather than O(n).
        drop = 0
        while drop < n and ts[drop] < cutoff:
            drop += 1

        if n - drop > self.max_rows:
            drop = n - self.max_rows

        if drop:
            for name in self.columns:
                del self.columns[name][:drop]
            self.base_offset += drop

    # -- reading ------------------------------------------------------------

    def snapshot(self, window_seconds: int | None = None) -> "Scan":
        """Return an immutable view of the rows inside `window_seconds`.

        The column lists are sliced (copied) under the lock so the executor can
        scan without holding it. At these sizes the copy is far cheaper than
        blocking ingest for the duration of a query.
        """
        with self._lock:
            n = len(self.columns["ts"])
            if n == 0:
                return Scan({name: [] for name in self.columns}, 0)

            start = 0
            if window_seconds is not None:
                cutoff = time.time() - window_seconds
                ts = self.columns["ts"]
                # Binary search: timestamps are effectively sorted.
                lo, hi = 0, n
                while lo < hi:
                    mid = (lo + hi) // 2
                    if ts[mid] < cutoff:
                        lo = mid + 1
                    else:
                        hi = mid
                start = lo

            return Scan({name: col[start:] for name, col in self.columns.items()}, n - start)

    def recent(self, limit: int = 50, human_only: bool = False) -> list[dict[str, Any]]:
        """Most recent rows, newest first -- powers the live event feed.

        `human_only` restricts to people editing real Wikipedia articles. The
        filter has to happen here rather than in the client: bots are ~58% of
        the stream and most of the rest is Wikidata, so filtering a batch of a
        dozen already-sent rows would usually leave one or two.

        The scan walks backwards and stops as soon as it has enough, so the cost
        is proportional to what is returned, not to the buffer size.
        """
        with self._lock:
            n = len(self.columns["ts"])
            cols = self.columns
            rows: list[dict[str, Any]] = []

            for i in range(n - 1, -1, -1):
                if human_only and (
                    cols["is_bot"][i]
                    or cols["project"][i] != "wikipedia"
                    or cols["namespace"][i] != 0
                ):
                    continue
                rows.append({name: col[i] for name, col in cols.items()})
                if len(rows) >= limit:
                    break

        return rows

    def stats(self) -> dict[str, Any]:
        with self._lock:
            n = len(self.columns["ts"])
            now = time.time()
            recent_cut = now - 60
            ts = self.columns["ts"]
            per_min = sum(1 for i in range(n - 1, -1, -1) if ts[i] >= recent_cut) if n else 0
            # Divide by elapsed time, not a flat 60s: for the first minute after
            # start there is less than a minute of data and a flat divisor
            # under-reports the rate by up to 60x.
            elapsed = max(1.0, min(60.0, now - self.started_at))
            return {
                "buffered_rows": n,
                "total_ingested": self.total_ingested,
                "events_per_second": round(per_min / elapsed, 2),
                "window_seconds": self.window_seconds,
                "rollup_minutes": len(self.rollups),
                "uptime_seconds": round(now - self.started_at, 1),
                "last_event_age": round(now - self.last_event_at, 2) if self.last_event_at else None,
            }

    def rollup_series(self, minutes: int = 180) -> list[dict]:
        with self._lock:
            keys = sorted(self.rollups)[-minutes:]
            return [self.rollups[k].to_dict() for k in keys]


class Scan:
    """An immutable columnar slice handed to the executor."""

    __slots__ = ("columns", "length")

    def __init__(self, columns: dict[str, list[Any]], length: int):
        self.columns = columns
        self.length = length

    def column(self, name: str) -> list[Any]:
        return self.columns[name]

    def __len__(self) -> int:
        return self.length


def _zero(t: ColType) -> Any:
    if t is ColType.STRING:
        return ""
    if t is ColType.BOOL:
        return False
    if t is ColType.FLOAT:
        return 0.0
    return 0
