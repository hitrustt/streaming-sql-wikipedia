"""FastAPI application: REST for one-shot queries, WebSocket for continuous ones.

One process owns one firehose connection and one store, shared by every
connected client. That is the only sane arrangement -- opening an upstream
connection per visitor would be rude to Wikimedia and would not scale past a
handful of tabs -- but it does mean the ingest task and the query loop share an
event loop, which is why query pacing is adaptive.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .ingest import STREAM_URL, FirehoseClient
from .presets import HEADLINE_SQL, PRESETS, PRESETS_BY_ID
from .schema import COLUMNS
from .sql.executor import run_query
from .sql.lexer import SqlError
from .sql.parser import parse
from .store import EventStore
from .subscriptions import Subscription

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
log = logging.getLogger("riverbed.app")

#: Cap on concurrent continuous queries per socket. Each one costs a full scan
#: per tick, so an unbounded number would let one tab degrade the service.
MAX_SUBSCRIPTIONS = 8

#: How often the live event feed and header stats are pushed.
FEED_INTERVAL = 1.0

store = EventStore()
firehose = FirehoseClient(sink=store.append_many, url=os.environ.get("STREAM_URL", STREAM_URL))


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(firehose.run(), name="firehose")
    log.info("ingest started")
    try:
        yield
    finally:
        firehose.stop()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        log.info("ingest stopped")


app = FastAPI(title="Riverbed", version="1.0", lifespan=lifespan)

# The API is public and read-only, so a permissive CORS policy costs nothing and
# lets the frontend run from a different origin in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.exception_handler(SqlError)
async def sql_error_handler(_request, exc: SqlError):
    """SQL problems are user input errors, not server faults."""
    return JSONResponse(status_code=400, content={"error": exc.to_dict()})


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    """Liveness for the host's health check.

    Deliberately reports unhealthy when the stream has been silent, so a wedged
    ingest gets the process restarted instead of serving a frozen dashboard.
    """
    stats = store.stats()
    ingest = firehose.stats.to_dict()
    age = stats.get("last_event_age")
    healthy = ingest["connected"] and (age is None or age < 120)
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "store": stats, "ingest": ingest},
    )


@app.get("/api/schema")
async def get_schema() -> dict:
    return {
        "table": "edits",
        "columns": [
            {"name": c.name, "type": c.type.value, "doc": c.doc, "facetable": c.facetable}
            for c in COLUMNS
        ],
        "source": {
            "name": "Wikimedia EventStreams",
            "url": STREAM_URL,
            "description": "Every edit to every Wikimedia wiki, as it happens.",
        },
    }


@app.get("/api/presets")
async def get_presets() -> dict:
    return {"presets": [p.to_dict() for p in PRESETS]}


@app.get("/api/stats")
async def get_stats() -> dict:
    return {"store": store.stats(), "ingest": firehose.stats.to_dict()}


@app.get("/api/history")
async def get_history(minutes: int = 180) -> dict:
    """Pre-aggregated history from the rollups, beyond raw retention."""
    minutes = max(1, min(minutes, 24 * 60))
    return {"minutes": minutes, "series": store.rollup_series(minutes)}


@app.get("/api/facets")
async def get_facets(column: str, limit: int = 15) -> dict:
    """Distinct values for a column, powering the click-to-filter UI."""
    from .schema import COLUMNS_BY_NAME

    col = COLUMNS_BY_NAME.get(column)
    if col is None or not col.facetable:
        raise HTTPException(status_code=400, detail=f"{column!r} is not a facetable column.")

    result = run_query(
        f"SELECT {column} AS value, count(*) AS n FROM edits "
        f"GROUP BY {column} ORDER BY n DESC LIMIT {max(1, min(limit, 50))} WINDOW 5m",
        store,
    )
    return {"column": column, "values": [{"value": r[0], "count": r[1]} for r in result.rows]}


@app.post("/api/query")
async def post_query(payload: dict) -> dict:
    """One-shot query execution, for sharing a link or scripting against."""
    sql = (payload or {}).get("sql", "")
    if not isinstance(sql, str):
        raise HTTPException(status_code=400, detail="'sql' must be a string.")
    result = run_query(sql, store)
    return result.to_dict()


@app.post("/api/explain")
async def post_explain(payload: dict) -> dict:
    """Parse and describe a query without running it -- used for live validation."""
    sql = (payload or {}).get("sql", "")
    query = parse(sql)
    return {
        "table": query.from_table,
        "aggregate": bool(query.group_by) or "count(" in sql.lower(),
        "group_by": [getattr(g, "name", "expr") for g in query.group_by],
        "window_seconds": query.window_seconds,
        "limit": query.limit,
    }


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

class Session:
    """Per-connection state: its subscriptions and its send lock."""

    def __init__(self, socket: WebSocket):
        self.socket = socket
        self.subscriptions: dict[str, Subscription] = {}
        self.want_feed = True
        # Defaults to people editing real articles. The unfiltered firehose is
        # mostly bots writing Wikidata item ids, which reads as noise.
        self.human_only = True
        self._lock = asyncio.Lock()

    async def send(self, message: dict) -> None:
        # Serialized: concurrent sends on one WebSocket interleave frames and
        # corrupt the stream.
        async with self._lock:
            await self.socket.send_text(json.dumps(message, default=str))


@app.websocket("/ws")
async def websocket_endpoint(socket: WebSocket) -> None:
    await socket.accept()
    session = Session(socket)

    await session.send({
        "type": "welcome",
        "presets": [p.to_dict() for p in PRESETS],
        "columns": [
            {"name": c.name, "type": c.type.value, "doc": c.doc, "facetable": c.facetable}
            for c in COLUMNS
        ],
        "stats": store.stats(),
        "ingest": firehose.stats.to_dict(),
    })

    pump = asyncio.create_task(_pump(session))
    try:
        while True:
            raw = await socket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await session.send({"type": "error", "message": "Malformed JSON."})
                continue
            await _handle(session, message)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("websocket session failed")
    finally:
        pump.cancel()


async def _handle(session: Session, message: dict) -> None:
    kind = message.get("type")

    if kind == "subscribe":
        sub_id = str(message.get("id") or "default")
        sql = message.get("sql") or ""

        if isinstance(message.get("preset"), str):
            preset = PRESETS_BY_ID.get(message["preset"])
            if preset is None:
                await session.send({"type": "error", "message": f"Unknown preset {message['preset']!r}."})
                return
            sql = preset.sql

        if sub_id not in session.subscriptions and len(session.subscriptions) >= MAX_SUBSCRIPTIONS:
            await session.send({
                "type": "error",
                "message": f"At most {MAX_SUBSCRIPTIONS} live queries per connection.",
            })
            return

        # Validate immediately so a typo is reported on submit rather than a
        # second later on the first tick.
        try:
            parse(sql)
        except SqlError as err:
            await session.send({"type": "query_error", "id": sub_id, "error": err.to_dict()})
            return

        session.subscriptions[sub_id] = Subscription(id=sub_id, sql=sql, next_run=0.0)
        return

    if kind == "unsubscribe":
        session.subscriptions.pop(str(message.get("id")), None)
        return

    if kind == "set_feed":
        session.want_feed = bool(message.get("enabled", True))
        if "human_only" in message:
            session.human_only = bool(message["human_only"])
        return

    if kind == "ping":
        await session.send({"type": "pong", "t": time.time()})
        return

    await session.send({"type": "error", "message": f"Unknown message type {kind!r}."})


async def _pump(session: Session) -> None:
    """Drives every continuous query and the live feed for one connection."""
    last_feed = 0.0
    try:
        while True:
            now = time.time()

            for sub in list(session.subscriptions.values()):
                if sub.due(now):
                    # Executing inline blocks the loop for the query's duration.
                    # At tens of milliseconds that is preferable to a thread
                    # pool, whose handoff cost would exceed the work itself --
                    # and adaptive pacing bounds the damage from slow queries.
                    await session.send(sub.evaluate(store))

            if session.want_feed and now - last_feed >= FEED_INTERVAL:
                last_feed = now
                await session.send({
                    "type": "feed",
                    "events": store.recent(12, human_only=session.human_only),
                    "stats": store.stats(),
                    "ingest": firehose.stats.to_dict(),
                    "headline": run_query(HEADLINE_SQL, store).to_dict(),
                })

            await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        raise
    except (WebSocketDisconnect, RuntimeError):
        return  # Client vanished mid-send; the session teardown handles it.
    except Exception:  # noqa: BLE001
        log.exception("pump failed")


# ---------------------------------------------------------------------------
# Static frontend (production: the built SPA is served from this same process)
# ---------------------------------------------------------------------------

_static = Path(__file__).parent / "static"
if _static.is_dir():
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")
