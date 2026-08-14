"""Continuous query subscriptions and result-delta computation.

A subscription is a SQL string plus the last result we sent to that client.
Every tick the query is re-run and the new result is diffed against the old
one; only the changed rows go over the wire.

This matters more than it looks. A top-15 table refreshed once a second is
~4KB of JSON per tick per client, but between two consecutive ticks usually
only one or two rows actually change. Sending diffs cuts steady-state traffic by
roughly an order of magnitude, and -- more visibly -- lets the frontend animate
precisely the cells that changed instead of repainting the whole table, which is
what makes a live dashboard feel calm rather than seizure-inducing.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from .sql.executor import QueryResult, run_query
from .sql.lexer import SqlError
from .store import EventStore

#: How often a continuous query is re-evaluated.
DEFAULT_TICK_SECONDS = 1.0

#: A query slower than this gets its tick interval stretched, so one expensive
#: query cannot starve the event loop for every other client.
SLOW_QUERY_MS = 250.0


@dataclass
class RowDelta:
    """One change to the result set, addressed by row key."""
    op: str  # "set" | "remove"
    key: str
    row: list[Any] | None = None
    index: int = 0

    def to_dict(self) -> dict:
        out: dict[str, Any] = {"op": self.op, "key": self.key, "index": self.index}
        if self.row is not None:
            out["row"] = self.row
        return out


@dataclass
class Subscription:
    id: str
    sql: str
    columns: list[str] = field(default_factory=list)
    #: Row key -> row values, as last sent to this client.
    last_rows: dict[str, list[Any]] = field(default_factory=dict)
    last_order: list[str] = field(default_factory=list)
    tick_seconds: float = DEFAULT_TICK_SECONDS
    next_run: float = 0.0
    error: str | None = None

    def due(self, now: float) -> bool:
        return now >= self.next_run

    def evaluate(self, store: EventStore) -> dict:
        """Run the query and return a message describing what changed."""
        try:
            result = run_query(self.sql, store)
        except SqlError as err:
            self.next_run = time.time() + 2.0  # Back off while the query is broken.
            self.error = err.message
            return {"type": "query_error", "id": self.id, "error": err.to_dict()}
        except Exception as exc:  # noqa: BLE001
            self.next_run = time.time() + 2.0
            self.error = str(exc)
            return {
                "type": "query_error",
                "id": self.id,
                "error": {"message": f"Query failed: {exc}", "start": 0, "end": 0, "hint": None},
            }

        self.error = None
        # Adaptive pacing: an expensive query runs less often rather than
        # monopolizing the loop.
        self.tick_seconds = (
            DEFAULT_TICK_SECONDS if result.elapsed_ms < SLOW_QUERY_MS
            else min(5.0, result.elapsed_ms / 100.0)
        )
        self.next_run = time.time() + self.tick_seconds

        # A changed column set means a different query shape; resend in full.
        if result.columns != self.columns:
            self.columns = list(result.columns)
            self.last_rows = {}
            self.last_order = []
            return self._full(result)

        return self._diff(result)

    def _full(self, result: QueryResult) -> dict:
        keys = [_row_key(row, i, result.key_columns) for i, row in enumerate(result.rows)]
        self.last_rows = dict(zip(keys, result.rows))
        self.last_order = keys
        return {
            "type": "result",
            "id": self.id,
            "full": True,
            "columns": result.columns,
            "rows": result.rows,
            "keys": keys,
            "meta": result.to_dict() | {"columns": result.columns, "rows": []},
        }

    def _diff(self, result: QueryResult) -> dict:
        keys = [_row_key(row, i, result.key_columns) for i, row in enumerate(result.rows)]
        new_rows = dict(zip(keys, result.rows))

        deltas: list[RowDelta] = []
        for index, key in enumerate(keys):
            previous = self.last_rows.get(key)
            row = new_rows[key]
            if previous != row:
                deltas.append(RowDelta("set", key, row, index))

        for key in self.last_rows:
            if key not in new_rows:
                deltas.append(RowDelta("remove", key))

        order_changed = keys != self.last_order
        self.last_rows = new_rows
        self.last_order = keys

        return {
            "type": "result",
            "id": self.id,
            "full": False,
            "columns": result.columns,
            "deltas": [d.to_dict() for d in deltas],
            "keys": keys if order_changed else None,
            "meta": result.to_dict() | {"columns": result.columns, "rows": []},
        }


def _row_key(row: list[Any], index: int, key_columns: int) -> str:
    """Identity for a result row across ticks.

    For an aggregate query the grouping keys are stable tick to tick, which is
    what lets the UI animate a row climbing the rankings instead of seeing it
    vanish and reappear somewhere else. All key columns are used: keying
    `GROUP BY title, lang` on the title alone would merge the English and German
    articles of the same name into one flickering row.

    Scalar queries have no such identity, so rows fall back to position.
    """
    if not row or key_columns <= 0:
        return f"#{index}"
    return "k:" + "\x1f".join(str(v) for v in row[:key_columns])
