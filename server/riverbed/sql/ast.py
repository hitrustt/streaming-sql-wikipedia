"""AST node definitions for the Riverbed SQL dialect.

Plain frozen dataclasses rather than a class hierarchy with `eval` methods on
each node: keeping the tree dumb means the planner is free to rewrite it
(constant folding, predicate pushdown) without the nodes carrying execution
state around. Evaluation lives entirely in the executor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union

Expr = Union[
    "Literal", "ColumnRef", "BinaryOp", "UnaryOp", "FuncCall", "AggCall",
    "InList", "Like", "IsNull", "Case",
]


@dataclass(frozen=True)
class Literal:
    value: Any
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class ColumnRef:
    name: str
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class BinaryOp:
    op: str
    left: Expr
    right: Expr
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class UnaryOp:
    op: str
    operand: Expr
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class FuncCall:
    """A scalar function: lower(), abs(), length(), ..."""
    name: str
    args: tuple[Expr, ...]
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class AggCall:
    """An aggregate: count/sum/avg/min/max/count_distinct/percentile/top_k.

    Held separately from FuncCall because the planner has to hoist these out of
    the projection list and into the aggregation operator, and conflating the
    two makes that pass much easier to get wrong.
    """
    name: str
    args: tuple[Expr, ...]
    distinct: bool = False
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class InList:
    operand: Expr
    values: tuple[Expr, ...]
    negated: bool = False
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class Like:
    operand: Expr
    pattern: Expr
    negated: bool = False
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class IsNull:
    operand: Expr
    negated: bool = False
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class Case:
    whens: tuple[tuple[Expr, Expr], ...]
    otherwise: Expr | None = None
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class SelectItem:
    expr: Expr
    alias: str | None = None


@dataclass(frozen=True)
class OrderItem:
    expr: Expr
    descending: bool = False


@dataclass(frozen=True)
class Query:
    select: tuple[SelectItem, ...]
    from_table: str
    where: Expr | None = None
    group_by: tuple[Expr, ...] = ()
    order_by: tuple[OrderItem, ...] = ()
    limit: int | None = None
    #: Rolling window in seconds. `WINDOW 5m` restricts the query to events in
    #: the last five minutes and is what makes a query *continuous* rather than
    #: a one-shot scan.
    window_seconds: int | None = None
    star: bool = False
    src: str = field(default="", compare=False)
