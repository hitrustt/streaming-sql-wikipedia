"""Executes a compiled Plan against a columnar Scan.

Execution is a re-scan of the window on every tick rather than incremental
maintenance of aggregate state. That is a deliberate trade and worth defending:
incremental aggregation is where streaming engines accumulate their subtlest
bugs (retraction on window expiry, out-of-order arrivals, non-invertible
aggregates like min/max that cannot be un-done). A full scan of a bounded
window is trivially correct, and at this window size it costs a few tens of
milliseconds. Incrementality is applied where it is *safe* and where it
actually matters instead: in the result deltas pushed over the WebSocket.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ..sketches import HyperLogLog, TDigest
from ..store import EventStore, Scan
from .lexer import SqlError
from .parser import parse
from .planner import Plan, plan

#: Guards against a pathological GROUP BY (e.g. grouping by `title` over a
#: full window) exhausting memory. Well past any sensible result size.
MAX_GROUPS = 200_000

#: Rows returned when a non-aggregate query omits LIMIT.
DEFAULT_ROW_LIMIT = 200


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[list[Any]]
    #: Rows examined after windowing -- surfaced in the UI so the cost is visible.
    scanned: int
    matched: int
    elapsed_ms: float
    truncated: bool = False
    window_seconds: int | None = None
    notes: list[str] = field(default_factory=list)
    #: How many leading projections correspond to GROUP BY keys. Used by the
    #: subscription layer to build a stable row identity across ticks; 0 means
    #: rows have no identity beyond their position.
    key_columns: int = 0

    def to_dict(self) -> dict:
        return {
            "columns": self.columns,
            "rows": self.rows,
            "scanned": self.scanned,
            "matched": self.matched,
            "elapsed_ms": round(self.elapsed_ms, 2),
            "truncated": self.truncated,
            "window_seconds": self.window_seconds,
            "notes": self.notes,
            "key_columns": self.key_columns,
        }


class _Acc:
    """Per-group accumulator for one aggregate."""

    __slots__ = ("name", "extra", "n", "total", "best", "hll", "digest", "counts")

    def __init__(self, name: str, extra: Any):
        self.name = name
        self.extra = extra
        self.n = 0
        self.total: float = 0.0
        self.best: Any = None
        self.hll: HyperLogLog | None = HyperLogLog(12) if name == "count_distinct" else None
        self.digest: TDigest | None = TDigest() if name == "percentile" else None
        self.counts: dict[str, int] | None = {} if name == "top_k" else None

    def update(self, value: Any) -> None:
        name = self.name
        if name == "count":
            self.n += 1
            return
        if value is None:
            return
        if name == "count_distinct":
            self.hll.add(str(value))  # type: ignore[union-attr]
            return
        if name == "percentile":
            self.digest.add(float(value))  # type: ignore[union-attr]
            return
        if name == "top_k":
            key = str(value)
            self.counts[key] = self.counts.get(key, 0) + 1  # type: ignore[union-attr]
            return
        if name in ("sum", "avg"):
            self.total += float(value)
            self.n += 1
            return
        if name == "min":
            if self.best is None or value < self.best:
                self.best = value
            return
        if name == "max":
            if self.best is None or value > self.best:
                self.best = value

    def finish(self) -> Any:
        name = self.name
        if name == "count":
            return self.n
        if name == "sum":
            return round(self.total, 6) if self.total % 1 else int(self.total)
        if name == "avg":
            return round(self.total / self.n, 3) if self.n else 0
        if name in ("min", "max"):
            return self.best
        if name == "count_distinct":
            return self.hll.count()  # type: ignore[union-attr]
        if name == "percentile":
            return round(self.digest.quantile(self.extra), 2)  # type: ignore[union-attr]
        if name == "top_k":
            top = sorted(self.counts.items(), key=lambda kv: (-kv[1], kv[0]))  # type: ignore[union-attr]
            return [list(kv) for kv in top[: self.extra]]
        return None


def execute(compiled: Plan, scan: Scan) -> QueryResult:
    started = time.perf_counter()
    n = len(scan)

    where = compiled.where
    if where is None:
        matching = range(n)
        matched = n
    else:
        matching = [i for i in range(n) if where(i)]
        matched = len(matching)

    notes: list[str] = []

    if compiled.is_aggregate:
        rows, truncated = _run_aggregate(compiled, matching, notes)
    else:
        rows, truncated = _run_scalar(compiled, matching, notes)

    elapsed = (time.perf_counter() - started) * 1000
    projection_names = [name for name, _ in compiled.projections]

    # Count the leading projections that are exactly grouping keys. Only a
    # contiguous run from the front counts, since the client keys rows on a
    # prefix of the row.
    key_columns = 0
    if compiled.is_aggregate:
        key_names = [name for name, _ in compiled.group_keys]
        for name in projection_names:
            if name in key_names:
                key_columns += 1
            else:
                break

    return QueryResult(
        columns=projection_names,
        rows=rows,
        scanned=n,
        matched=matched,
        elapsed_ms=elapsed,
        truncated=truncated,
        window_seconds=compiled.window_seconds,
        notes=notes,
        key_columns=key_columns,
    )


def _run_aggregate(compiled: Plan, matching, notes: list[str]) -> tuple[list[list[Any]], bool]:
    key_fns = [fn for _, fn in compiled.group_keys]
    specs = compiled.aggs

    # group key tuple -> (representative row index, accumulators)
    groups: dict[tuple, tuple[int, list[_Acc]]] = {}
    overflowed = False

    for i in matching:
        key = tuple(fn(i) for fn in key_fns) if key_fns else ()
        entry = groups.get(key)
        if entry is None:
            if len(groups) >= MAX_GROUPS:
                overflowed = True
                continue
            entry = groups[key] = (i, [_Acc(s.name, s.extra) for s in specs])
        accs = entry[1]
        for spec, acc in zip(specs, accs):
            acc.update(spec.arg(i) if spec.arg is not None else None)

    if overflowed:
        notes.append(
            f"Group cardinality exceeded {MAX_GROUPS:,}; extra groups were dropped. "
            "Add a WHERE filter or group by a lower-cardinality column."
        )

    # An aggregate with no GROUP BY over zero rows still returns one row, which
    # is what makes `SELECT count(*) FROM edits` show 0 rather than nothing.
    if not groups and not key_fns:
        groups[()] = (0, [_Acc(s.name, s.extra) for s in specs])

    # Finish each group's accumulators exactly once: top_k sorts its candidate
    # map and percentile flushes its digest, so finishing twice is real work.
    finished = [
        (row_index, [acc.finish() for acc in accs])
        for row_index, accs in groups.values()
    ]

    if compiled.order_by:
        # Sort keys come from the group's representative row plus its finished
        # aggregate values, so ORDER BY can reference either. Sorting by each
        # key in reverse order relies on Python's stable sort to produce correct
        # multi-key ordering.
        keyed = [
            ([fn(row_index, values) for fn, _ in compiled.order_by], row_index, values)
            for row_index, values in finished
        ]
        for pos in reversed(range(len(compiled.order_by))):
            descending = compiled.order_by[pos][1]
            keyed.sort(key=lambda kv, p=pos: _sort_key(kv[0][p]), reverse=descending)
        finished = [(row_index, values) for _keys, row_index, values in keyed]

    out: list[list[Any]] = [
        [fn(row_index, values) for _, fn in compiled.projections]
        for row_index, values in finished
    ]

    truncated = False
    if compiled.limit is not None and len(out) > compiled.limit:
        out = out[: compiled.limit]
        truncated = True
    return out, truncated


def _run_scalar(compiled: Plan, matching, notes: list[str]) -> tuple[list[list[Any]], bool]:
    limit = compiled.limit if compiled.limit is not None else DEFAULT_ROW_LIMIT
    if compiled.limit is None:
        notes.append(f"No LIMIT given; showing the {DEFAULT_ROW_LIMIT} most recent matches.")

    indexes = list(matching)

    if compiled.order_by:
        for pos in reversed(range(len(compiled.order_by))):
            fn, descending = compiled.order_by[pos]
            indexes.sort(key=lambda i, f=fn: _sort_key(f(i, _EMPTY)), reverse=descending)
    else:
        # Newest first: the stream's natural order is oldest-first, and a live
        # feed that scrolls the wrong way feels broken.
        indexes.reverse()

    truncated = len(indexes) > limit
    indexes = indexes[:limit]
    rows = [[fn(i, _EMPTY) for _, fn in compiled.projections] for i in indexes]
    return rows, truncated


_EMPTY: list[Any] = []


def _sort_key(value: Any):
    """Total order across mixed types, since a column can hold both.

    Python refuses to compare str with int; a live query must not crash because
    one group key happened to be empty. Sorting by (type_rank, value) keeps the
    ordering stable and predictable.
    """
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (2, value)
    if isinstance(value, str):
        return (3, value)
    return (4, str(value))


def run_query(sql: str, store: EventStore, default_window: int | None = None) -> QueryResult:
    """Parse, plan, and execute `sql` against the live store."""
    query = parse(sql)

    window = query.window_seconds if query.window_seconds is not None else default_window
    if window is not None and window > store.window_seconds:
        raise SqlError(
            f"WINDOW {window}s exceeds the {store.window_seconds // 60}-minute raw retention.",
            0, len(sql),
            hint="Longer horizons are served by /api/history, which reads the rollups.",
        )

    scan = store.snapshot(window)
    compiled = plan(query, scan.columns, time.time())
    result = execute(compiled, scan)
    result.window_seconds = window
    return result
