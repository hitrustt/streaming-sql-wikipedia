"""Validation, optimization, and compilation of a parsed query.

The planner does three jobs before a single row is touched:

1. **Validate** against the schema, so unknown columns are caught with a
   suggestion instead of blowing up mid-scan on row 40,000.
2. **Optimize**: constant-fold literal subtrees, and order the WHERE
   conjuncts so cheap predicates run first and reject rows before expensive
   ones (a `LIKE` on `comment` is far dearer than `is_bot = false`).
3. **Compile** each expression into a Python closure over the column arrays.
   Interpreting the AST per row costs a dispatch on every node for every row;
   compiling once and calling a closure removes that inner-loop overhead
   entirely, which at 250k buffered rows is the difference between a query
   feeling instant and feeling broken.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass
from typing import Any, Callable

from ..schema import COLUMNS_BY_NAME, ColType, is_numeric
from .ast import (
    AggCall, BinaryOp, Case, ColumnRef, Expr, FuncCall, InList, IsNull, Like,
    Literal, Query, UnaryOp,
)
from .lexer import SqlError

TABLES = {"edits"}

#: Cost weights used only for ordering conjuncts; relative, not absolute.
_COST = {"column": 1, "literal": 0, "compare": 2, "like": 20, "func": 5, "in": 3}

RowFn = Callable[[int], Any]


@dataclass
class AggSpec:
    """One aggregate to compute per group."""
    key: str
    name: str
    arg: RowFn | None
    extra: Any = None


@dataclass
class Plan:
    query: Query
    where: RowFn | None
    group_keys: list[tuple[str, RowFn]]
    aggs: list[AggSpec]
    projections: list[tuple[str, Callable[[int, list[Any]], Any]]]
    order_by: list[tuple[Callable[[int, list[Any]], Any], bool]]
    limit: int | None
    window_seconds: int | None
    is_aggregate: bool
    columns_used: set[str]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _check_column(name: str, start: int, end: int) -> None:
    if name in COLUMNS_BY_NAME:
        return
    close = difflib.get_close_matches(name, COLUMNS_BY_NAME, n=1, cutoff=0.6)
    hint = f"Did you mean {close[0]!r}?" if close else (
        "Available columns: " + ", ".join(COLUMNS_BY_NAME)
    )
    raise SqlError(f"Unknown column {name!r}.", start, end, hint=hint)


def _walk(expr: Expr):
    yield expr
    for child in _children(expr):
        yield from _walk(child)


def _children(expr: Expr) -> list[Expr]:
    if isinstance(expr, BinaryOp):
        return [expr.left, expr.right]
    if isinstance(expr, UnaryOp):
        return [expr.operand]
    if isinstance(expr, (FuncCall, AggCall)):
        return list(expr.args)
    if isinstance(expr, InList):
        return [expr.operand, *expr.values]
    if isinstance(expr, Like):
        return [expr.operand, expr.pattern]
    if isinstance(expr, IsNull):
        return [expr.operand]
    if isinstance(expr, Case):
        out: list[Expr] = []
        for cond, then in expr.whens:
            out.extend((cond, then))
        if expr.otherwise is not None:
            out.append(expr.otherwise)
        return out
    return []


def _has_agg(expr: Expr) -> bool:
    return any(isinstance(node, AggCall) for node in _walk(expr))


# ---------------------------------------------------------------------------
# Optimization
# ---------------------------------------------------------------------------

def _fold(expr: Expr) -> Expr:
    """Constant-fold literal-only subtrees so they aren't recomputed per row."""
    if isinstance(expr, BinaryOp):
        left, right = _fold(expr.left), _fold(expr.right)
        if isinstance(left, Literal) and isinstance(right, Literal):
            try:
                return Literal(_apply_binary(expr.op, left.value, right.value),
                               expr.start, expr.end)
            except Exception:
                pass  # Leave it to fail at runtime with real values.
        return BinaryOp(expr.op, left, right, expr.start, expr.end)
    if isinstance(expr, UnaryOp):
        operand = _fold(expr.operand)
        if isinstance(operand, Literal):
            if expr.op == "-" and isinstance(operand.value, (int, float)):
                return Literal(-operand.value, expr.start, expr.end)
            if expr.op == "not":
                return Literal(not _truthy(operand.value), expr.start, expr.end)
        return UnaryOp(expr.op, operand, expr.start, expr.end)
    return expr


def _cost(expr: Expr) -> int:
    if isinstance(expr, Literal):
        return _COST["literal"]
    if isinstance(expr, ColumnRef):
        return _COST["column"]
    if isinstance(expr, Like):
        return _COST["like"] + _cost(expr.operand)
    if isinstance(expr, InList):
        return _COST["in"] + _cost(expr.operand)
    if isinstance(expr, FuncCall):
        return _COST["func"] + sum(_cost(a) for a in expr.args)
    if isinstance(expr, BinaryOp):
        return _COST["compare"] + _cost(expr.left) + _cost(expr.right)
    return sum(_cost(c) for c in _children(expr)) + 1


def _split_conjuncts(expr: Expr) -> list[Expr]:
    if isinstance(expr, BinaryOp) and expr.op == "and":
        return _split_conjuncts(expr.left) + _split_conjuncts(expr.right)
    return [expr]


def _reorder_where(expr: Expr) -> Expr:
    """Cheapest conjunct first: short-circuiting then rejects rows sooner."""
    parts = _split_conjuncts(expr)
    if len(parts) < 2:
        return expr
    parts.sort(key=_cost)
    out = parts[0]
    for part in parts[1:]:
        out = BinaryOp("and", out, part, out.start, part.end)
    return out


# ---------------------------------------------------------------------------
# Runtime helpers
# ---------------------------------------------------------------------------

def _truthy(v: Any) -> bool:
    return bool(v)


def _apply_binary(op: str, a: Any, b: Any) -> Any:
    if op == "and":
        return _truthy(a) and _truthy(b)
    if op == "or":
        return _truthy(a) or _truthy(b)
    if op == "=":
        return a == b
    if op in ("!=", "<>"):
        return a != b
    if op == "||":
        return f"{a}{b}"

    if op in ("<", ">", "<=", ">="):
        # Comparing a string column against a number is a common typo; give a
        # real message rather than a TypeError from deep in the scan.
        if isinstance(a, str) != isinstance(b, str):
            raise SqlError(f"Cannot compare {type(a).__name__} with {type(b).__name__}.")
        if op == "<":
            return a < b
        if op == ">":
            return a > b
        if op == "<=":
            return a <= b
        return a >= b

    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return 0 if b == 0 else a / b
    if op == "%":
        return 0 if b == 0 else a % b
    raise SqlError(f"Unsupported operator {op!r}.")


def _like_to_regex(pattern: str) -> Callable[[str], bool]:
    """Translate SQL LIKE into a predicate.

    Fast paths for the three shapes that cover nearly all real usage
    ('%x%', 'x%', '%x') avoid the regex engine entirely, which matters when the
    predicate runs over a quarter-million rows every second.
    """
    import re

    if pattern.startswith("%") and pattern.endswith("%") and "%" not in pattern[1:-1] and "_" not in pattern:
        needle = pattern[1:-1].lower()
        return lambda s: needle in s.lower()
    if pattern.endswith("%") and "%" not in pattern[:-1] and "_" not in pattern:
        prefix = pattern[:-1].lower()
        return lambda s: s.lower().startswith(prefix)
    if pattern.startswith("%") and "%" not in pattern[1:] and "_" not in pattern:
        suffix = pattern[1:].lower()
        return lambda s: s.lower().endswith(suffix)

    regex = re.compile(
        "^" + "".join(
            ".*" if ch == "%" else "." if ch == "_" else re.escape(ch)
            for ch in pattern
        ) + "$",
        re.IGNORECASE | re.DOTALL,
    )
    return lambda s: regex.match(s) is not None


SCALAR_IMPL: dict[str, Callable[..., Any]] = {
    "lower": lambda s: str(s).lower(),
    "upper": lambda s: str(s).upper(),
    "length": lambda s: len(str(s)),
    "abs": lambda x: abs(x),
    "round": lambda x, d=0: round(x, int(d)),
    "coalesce": lambda *xs: next((x for x in xs if x not in (None, "")), None),
    "substr": lambda s, start, n=None: str(s)[int(start):int(start) + int(n)] if n is not None else str(s)[int(start):],
}

ARITY: dict[str, tuple[int, int]] = {
    "lower": (1, 1), "upper": (1, 1), "length": (1, 1), "abs": (1, 1),
    "round": (1, 2), "coalesce": (1, 8), "substr": (2, 3), "now": (0, 0),
}

AGG_ARITY: dict[str, tuple[int, int]] = {
    "count": (0, 1), "count_distinct": (1, 1), "sum": (1, 1), "avg": (1, 1),
    "min": (1, 1), "max": (1, 1), "percentile": (2, 2), "top_k": (1, 2),
}


# ---------------------------------------------------------------------------
# Compilation
# ---------------------------------------------------------------------------

class _Compiler:
    """Compiles AST nodes into closures over a column dictionary.

    Each closure takes a row index and an `aggs` list. Non-aggregate
    expressions ignore `aggs`; aggregate references read their slot from it.
    That single uniform signature is what lets projections mix grouped columns
    and aggregates (`SELECT lang, count(*) / 60`) without a second code path.
    """

    def __init__(self, columns: dict[str, list[Any]], now: float):
        self.columns = columns
        self.now = now
        self.agg_specs: list[AggSpec] = []
        self._agg_slots: dict[str, int] = {}
        self.columns_used: set[str] = set()

    # Aggregates are keyed by their source text so that `count(*)` appearing in
    # both SELECT and ORDER BY is computed once.
    def _agg_slot(self, node: AggCall) -> int:
        key = f"{node.name}|{node.distinct}|{[_key_of(a) for a in node.args]}"
        if key in self._agg_slots:
            return self._agg_slots[key]

        lo, hi = AGG_ARITY[node.name]
        if not lo <= len(node.args) <= hi:
            raise SqlError(
                f"{node.name}() takes {lo} to {hi} arguments, got {len(node.args)}.",
                node.start, node.end,
            )
        for arg in node.args:
            if _has_agg(arg):
                raise SqlError("Aggregates cannot be nested.", node.start, node.end)

        extra: Any = None
        arg_fn: RowFn | None = None

        if node.name == "percentile":
            pct = node.args[1]
            if not isinstance(pct, Literal) or not isinstance(pct.value, (int, float)):
                raise SqlError(
                    "percentile() needs a constant percentile, e.g. percentile(delta, 95).",
                    node.start, node.end,
                )
            if not 0 <= pct.value <= 100:
                raise SqlError("Percentile must be between 0 and 100.", node.start, node.end)
            extra = float(pct.value) / 100.0
            arg_fn = self._wrap(self.compile(node.args[0]))
        elif node.name == "top_k":
            extra = 10
            if len(node.args) == 2:
                k = node.args[1]
                if not isinstance(k, Literal) or not isinstance(k.value, int):
                    raise SqlError("top_k() needs a constant k.", node.start, node.end)
                extra = max(1, min(int(k.value), 100))
            arg_fn = self._wrap(self.compile(node.args[0]))
        elif node.args:
            arg_fn = self._wrap(self.compile(node.args[0]))

        slot = len(self.agg_specs)
        self._agg_slots[key] = slot
        self.agg_specs.append(AggSpec(key=key, name=node.name, arg=arg_fn, extra=extra))
        return slot

    @staticmethod
    def _wrap(fn: Callable[[int, list[Any]], Any]) -> RowFn:
        """Aggregate arguments can never contain aggregates, so drop the slot arg."""
        return lambda i: fn(i, _NO_AGGS)

    def compile(self, expr: Expr) -> Callable[[int, list[Any]], Any]:
        if isinstance(expr, Literal):
            value = expr.value
            return lambda i, a: value

        if isinstance(expr, ColumnRef):
            _check_column(expr.name, expr.start, expr.end)
            self.columns_used.add(expr.name)
            col = self.columns[expr.name]
            return lambda i, a: col[i]

        if isinstance(expr, AggCall):
            slot = self._agg_slot(expr)
            return lambda i, a: a[slot]

        if isinstance(expr, BinaryOp):
            op = expr.op
            left = self.compile(expr.left)
            right = self.compile(expr.right)
            if op == "and":
                return lambda i, a: _truthy(left(i, a)) and _truthy(right(i, a))
            if op == "or":
                return lambda i, a: _truthy(left(i, a)) or _truthy(right(i, a))
            start, end = expr.start, expr.end

            def binary(i: int, a: list[Any]) -> Any:
                try:
                    return _apply_binary(op, left(i, a), right(i, a))
                except SqlError as err:
                    raise SqlError(err.message, start, end, hint=err.hint) from None
            return binary

        if isinstance(expr, UnaryOp):
            operand = self.compile(expr.operand)
            if expr.op == "-":
                return lambda i, a: -operand(i, a)
            return lambda i, a: not _truthy(operand(i, a))

        if isinstance(expr, Like):
            operand = self.compile(expr.operand)
            if not isinstance(expr.pattern, Literal) or not isinstance(expr.pattern.value, str):
                raise SqlError(
                    "LIKE needs a constant string pattern.", expr.start, expr.end,
                    hint="Example: title LIKE '%Climate%'",
                )
            matcher = _like_to_regex(expr.pattern.value)
            if expr.negated:
                return lambda i, a: not matcher(str(operand(i, a)))
            return lambda i, a: matcher(str(operand(i, a)))

        if isinstance(expr, InList):
            operand = self.compile(expr.operand)
            if all(isinstance(v, Literal) for v in expr.values):
                # Hash-set membership instead of a linear comparison chain.
                members = frozenset(v.value for v in expr.values)  # type: ignore[attr-defined]
                if expr.negated:
                    return lambda i, a: operand(i, a) not in members
                return lambda i, a: operand(i, a) in members
            value_fns = [self.compile(v) for v in expr.values]
            if expr.negated:
                return lambda i, a: all(operand(i, a) != f(i, a) for f in value_fns)
            return lambda i, a: any(operand(i, a) == f(i, a) for f in value_fns)

        if isinstance(expr, IsNull):
            operand = self.compile(expr.operand)
            # There are no true NULLs in the stream; absent values normalize to
            # the column's zero value, so IS NULL means "empty".
            if expr.negated:
                return lambda i, a: operand(i, a) not in (None, "")
            return lambda i, a: operand(i, a) in (None, "")

        if isinstance(expr, Case):
            branches = [(self.compile(c), self.compile(t)) for c, t in expr.whens]
            otherwise = self.compile(expr.otherwise) if expr.otherwise is not None else None

            def case_fn(i: int, a: list[Any]) -> Any:
                for cond, then in branches:
                    if _truthy(cond(i, a)):
                        return then(i, a)
                return otherwise(i, a) if otherwise else None
            return case_fn

        if isinstance(expr, FuncCall):
            name = expr.name
            lo, hi = ARITY[name]
            if not lo <= len(expr.args) <= hi:
                raise SqlError(
                    f"{name}() takes {lo} to {hi} arguments, got {len(expr.args)}.",
                    expr.start, expr.end,
                )
            if name == "now":
                now = self.now
                return lambda i, a: now
            impl = SCALAR_IMPL[name]
            arg_fns = [self.compile(arg) for arg in expr.args]
            start, end = expr.start, expr.end

            def call(i: int, a: list[Any]) -> Any:
                try:
                    return impl(*[f(i, a) for f in arg_fns])
                except SqlError:
                    raise
                except Exception as exc:
                    raise SqlError(f"{name}() failed: {exc}", start, end) from None
            return call

        raise SqlError(f"Cannot evaluate {type(expr).__name__}.")


_NO_AGGS: list[Any] = []


def _key_of(expr: Expr) -> str:
    """Structural key used to deduplicate identical aggregate calls."""
    if isinstance(expr, Literal):
        return f"lit:{expr.value!r}"
    if isinstance(expr, ColumnRef):
        return f"col:{expr.name}"
    if isinstance(expr, BinaryOp):
        return f"({_key_of(expr.left)}{expr.op}{_key_of(expr.right)})"
    if isinstance(expr, UnaryOp):
        return f"{expr.op}({_key_of(expr.operand)})"
    if isinstance(expr, (FuncCall, AggCall)):
        return f"{expr.name}({','.join(_key_of(a) for a in expr.args)})"
    return repr(expr)


def _display_name(item, index: int) -> str:
    if item.alias:
        return item.alias
    expr = item.expr
    if isinstance(expr, ColumnRef):
        return expr.name
    if isinstance(expr, AggCall):
        if expr.name == "count" and not expr.args:
            return "count"
        return f"{expr.name}_{_key_of(expr.args[0]).split(':')[-1]}" if expr.args else expr.name
    return f"col{index + 1}"


def plan(query: Query, columns: dict[str, list[Any]], now: float) -> Plan:
    """Validate, optimize, and compile `query` against the given columns."""
    if query.from_table not in TABLES:
        raise SqlError(
            f"Unknown table {query.from_table!r}.", 0, 0,
            hint=f"The only table is {', '.join(sorted(TABLES))}.",
        )

    compiler = _Compiler(columns, now)

    # WHERE cannot contain aggregates (that would be HAVING, which this dialect
    # does not support -- callers can filter the result client-side).
    where_fn: RowFn | None = None
    if query.where is not None:
        if _has_agg(query.where):
            raise SqlError(
                "Aggregates are not allowed in WHERE.",
                query.where.start, query.where.end,
                hint="Filter on raw columns; aggregate filters aren't supported yet.",
            )
        optimized = _reorder_where(_fold(query.where))
        compiled = compiler.compile(optimized)
        where_fn = lambda i: _truthy(compiled(i, _NO_AGGS))  # noqa: E731

    select_items = list(query.select)
    if query.star:
        from ..schema import COLUMNS
        from .ast import SelectItem
        select_items = [SelectItem(ColumnRef(c.name), c.name) for c in COLUMNS]

    # GROUP BY keys are compiled first so their aliases can be referenced by
    # ORDER BY, and so an aggregate accidentally used as a key is rejected.
    group_keys: list[tuple[str, RowFn]] = []
    group_key_structs: set[str] = set()
    for expr in query.group_by:
        if _has_agg(expr):
            raise SqlError("Aggregates are not allowed in GROUP BY.", expr.start, expr.end)
        resolved = _resolve_alias(expr, select_items)
        fn = compiler.compile(_fold(resolved))
        if isinstance(expr, ColumnRef):
            name = expr.name  # Keeps the alias when GROUP BY referenced one.
        elif isinstance(resolved, ColumnRef):
            name = resolved.name
        else:
            name = _key_of(resolved)
        group_keys.append((name, (lambda f: lambda i: f(i, _NO_AGGS))(fn)))
        # Structural key, so `GROUP BY who` where `who` aliases a CASE marks
        # that whole CASE expression as grouped -- not just the name `who`.
        group_key_structs.add(_key_of(_fold(resolved)))

    projections: list[tuple[str, Callable[[int, list[Any]], Any]]] = []
    for idx, item in enumerate(select_items):
        projections.append((_display_name(item, idx), compiler.compile(_fold(item.expr))))

    order_by: list[tuple[Callable[[int, list[Any]], Any], bool]] = []
    for order in query.order_by:
        resolved = _resolve_alias(order.expr, select_items)
        order_by.append((compiler.compile(_fold(resolved)), order.descending))

    is_aggregate = bool(query.group_by) or bool(compiler.agg_specs)

    # A grouped query whose SELECT mentions a bare column that isn't a grouping
    # key produces a nondeterministic value. Most engines silently pick one row;
    # rejecting it is friendlier than returning a number that changes each tick.
    if is_aggregate:
        for item in select_items:
            _check_grouped(_fold(item.expr), group_key_structs)

    return Plan(
        query=query,
        where=where_fn,
        group_keys=group_keys,
        aggs=compiler.agg_specs,
        projections=projections,
        order_by=order_by,
        limit=query.limit,
        window_seconds=query.window_seconds,
        is_aggregate=is_aggregate,
        columns_used=compiler.columns_used,
    )


def _check_grouped(expr: Expr, group_key_structs: set[str]) -> None:
    """Reject bare columns in a grouped SELECT that aren't a grouping key.

    Walks top-down and prunes: an expression that *is* a grouping key, or is an
    aggregate, is legal in its entirety and its children need no checking. Only
    a column reached without passing through either is an error. Most engines
    silently return an arbitrary row's value here; on a live query that means a
    number that flickers every tick, so it is better rejected outright.
    """
    if _key_of(expr) in group_key_structs or isinstance(expr, AggCall):
        return
    if isinstance(expr, ColumnRef):
        raise SqlError(
            f"Column {expr.name!r} must appear in GROUP BY or inside an aggregate.",
            expr.start, expr.end,
            hint=f"Either add it: GROUP BY {expr.name}, or wrap it, e.g. max({expr.name}).",
        )
    for child in _children(expr):
        _check_grouped(child, group_key_structs)


def _resolve_alias(expr: Expr, select_items) -> Expr:
    """Let ORDER BY / GROUP BY reference a SELECT alias by name.

    `SELECT count(*) AS n ... ORDER BY n DESC` is the single most common thing
    people type, and rejecting it because `n` isn't a column would be hostile.
    A bare name that is neither an alias nor a column falls through to normal
    column validation, which produces the better error message.
    """
    if isinstance(expr, ColumnRef) and expr.name not in COLUMNS_BY_NAME:
        for item in select_items:
            if item.alias == expr.name:
                return item.expr
    return expr
