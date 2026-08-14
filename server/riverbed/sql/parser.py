"""Recursive-descent parser with precedence climbing for binary operators.

Precedence climbing rather than a stack of one-function-per-level: adding an
operator becomes a table entry instead of a new function, and the expression
grammar stays one readable function. Every node records source offsets so
errors can be underlined in the editor.
"""

from __future__ import annotations

from .ast import (
    AggCall, BinaryOp, Case, ColumnRef, Expr, FuncCall, InList, IsNull, Like,
    Literal, OrderItem, Query, SelectItem, UnaryOp,
)
from .lexer import SqlError, TokType, Token, parse_duration, tokenize

# Higher binds tighter.
PRECEDENCE: dict[str, int] = {
    "or": 1,
    "and": 2,
    "=": 3, "!=": 3, "<>": 3, "<": 3, ">": 3, "<=": 3, ">=": 3,
    "+": 4, "-": 4, "||": 4,
    "*": 5, "/": 5, "%": 5,
}

AGGREGATES = {
    "count", "sum", "avg", "min", "max", "count_distinct", "percentile", "top_k",
}

SCALAR_FUNCS = {
    "lower", "upper", "length", "abs", "round", "coalesce", "substr", "now",
}


class Parser:
    def __init__(self, src: str):
        self.src = src
        self.tokens = tokenize(src)
        self.pos = 0

    # -- token helpers ------------------------------------------------------

    @property
    def cur(self) -> Token:
        return self.tokens[self.pos]

    def at_keyword(self, *words: str) -> bool:
        return self.cur.type is TokType.KEYWORD and self.cur.value.lower() in words

    def advance(self) -> Token:
        tok = self.cur
        if tok.type is not TokType.EOF:
            self.pos += 1
        return tok

    def expect_keyword(self, word: str) -> Token:
        if not self.at_keyword(word):
            raise SqlError(
                f"Expected {word.upper()} but found {self._describe(self.cur)}.",
                self.cur.start, self.cur.end,
            )
        return self.advance()

    def expect(self, ttype: TokType, what: str) -> Token:
        if self.cur.type is not ttype:
            raise SqlError(
                f"Expected {what} but found {self._describe(self.cur)}.",
                self.cur.start, self.cur.end,
            )
        return self.advance()

    @staticmethod
    def _describe(tok: Token) -> str:
        if tok.type is TokType.EOF:
            return "end of query"
        return repr(tok.value)

    # -- entry point --------------------------------------------------------

    def parse(self) -> Query:
        query = self.parse_query()
        if self.cur.type is not TokType.EOF:
            raise SqlError(
                f"Unexpected {self._describe(self.cur)} after end of query.",
                self.cur.start, self.cur.end,
                hint="Riverbed supports one statement at a time.",
            )
        return query

    def parse_query(self) -> Query:
        self.expect_keyword("select")

        star = False
        items: list[SelectItem] = []
        if self.cur.type is TokType.STAR:
            self.advance()
            star = True
        else:
            items.append(self.parse_select_item())
            while self.cur.type is TokType.COMMA:
                self.advance()
                items.append(self.parse_select_item())

        self.expect_keyword("from")
        table = self.expect(TokType.IDENT, "a table name").value

        where = None
        if self.at_keyword("where"):
            self.advance()
            where = self.parse_expr()

        group_by: list[Expr] = []
        if self.at_keyword("group"):
            self.advance()
            self.expect_keyword("by")
            group_by.append(self.parse_expr())
            while self.cur.type is TokType.COMMA:
                self.advance()
                group_by.append(self.parse_expr())

        order_by: list[OrderItem] = []
        if self.at_keyword("order"):
            self.advance()
            self.expect_keyword("by")
            order_by.append(self.parse_order_item())
            while self.cur.type is TokType.COMMA:
                self.advance()
                order_by.append(self.parse_order_item())

        limit = None
        if self.at_keyword("limit"):
            self.advance()
            tok = self.expect(TokType.NUMBER, "a row count after LIMIT")
            if "." in tok.value:
                raise SqlError("LIMIT must be a whole number.", tok.start, tok.end)
            limit = int(tok.value)

        window_seconds = None
        if self.at_keyword("window"):
            tok = self.advance()
            if self.cur.type is not TokType.DURATION:
                raise SqlError(
                    "WINDOW needs a duration such as 30s, 5m, 1h, or 1d.",
                    self.cur.start if self.cur.type is not TokType.EOF else tok.start,
                    self.cur.end if self.cur.type is not TokType.EOF else tok.end,
                    hint="Example: WINDOW 5m",
                )
            window_seconds = parse_duration(self.advance().value)

        return Query(
            select=tuple(items),
            from_table=table,
            where=where,
            group_by=tuple(group_by),
            order_by=tuple(order_by),
            limit=limit,
            window_seconds=window_seconds,
            star=star,
            src=self.src,
        )

    def parse_select_item(self) -> SelectItem:
        expr = self.parse_expr()
        alias = None
        if self.at_keyword("as"):
            self.advance()
            alias = self.expect(TokType.IDENT, "an alias name").value
        elif self.cur.type is TokType.IDENT:
            # Bare alias: `count(*) edits`
            alias = self.advance().value
        return SelectItem(expr=expr, alias=alias)

    def parse_order_item(self) -> OrderItem:
        expr = self.parse_expr()
        descending = False
        if self.at_keyword("asc", "desc"):
            descending = self.advance().value.lower() == "desc"
        return OrderItem(expr=expr, descending=descending)

    # -- expressions --------------------------------------------------------

    def parse_expr(self, min_prec: int = 0) -> Expr:
        # Postfix (IN / LIKE / IS NULL) binds to the operand, tighter than any
        # binary operator, so it must be applied here rather than after the
        # loop -- otherwise `a LIKE 'x' AND b` would stop parsing at the AND.
        left = self.parse_postfix(self.parse_unary())

        while True:
            op = self._peek_binary_op()
            if op is None or PRECEDENCE[op] < min_prec:
                break
            self.advance()
            # All supported binary operators are left-associative, so the right
            # side must bind strictly tighter.
            right = self.parse_expr(PRECEDENCE[op] + 1)
            left = BinaryOp(op=op, left=left, right=right, start=left.start, end=right.end)

        return left

    def _peek_binary_op(self) -> str | None:
        tok = self.cur
        if tok.type is TokType.OP and tok.value in PRECEDENCE:
            return tok.value
        if tok.type is TokType.STAR:
            return "*"
        if tok.type is TokType.KEYWORD and tok.value.lower() in ("and", "or"):
            return tok.value.lower()
        return None

    def parse_postfix(self, expr: Expr) -> Expr:
        """IN, LIKE, IS NULL, and their NOT forms bind after binary operators."""
        while True:
            negated = False
            save = self.pos
            if self.at_keyword("not"):
                self.advance()
                negated = True
                if not self.at_keyword("in", "like"):
                    self.pos = save
                    return expr

            if self.at_keyword("in"):
                self.advance()
                self.expect(TokType.LPAREN, "'(' after IN")
                values: list[Expr] = [self.parse_expr()]
                while self.cur.type is TokType.COMMA:
                    self.advance()
                    values.append(self.parse_expr())
                close = self.expect(TokType.RPAREN, "')' to close the IN list")
                expr = InList(expr, tuple(values), negated, expr.start, close.end)
                continue

            if self.at_keyword("like"):
                self.advance()
                pattern = self.parse_unary()
                expr = Like(expr, pattern, negated, expr.start, pattern.end)
                continue

            if self.at_keyword("is"):
                self.advance()
                is_negated = False
                if self.at_keyword("not"):
                    self.advance()
                    is_negated = True
                tok = self.expect_keyword("null")
                expr = IsNull(expr, is_negated, expr.start, tok.end)
                continue

            return expr

    def parse_unary(self) -> Expr:
        tok = self.cur
        if tok.type is TokType.OP and tok.value == "-":
            self.advance()
            operand = self.parse_unary()
            return UnaryOp("-", operand, tok.start, operand.end)
        if self.at_keyword("not"):
            self.advance()
            operand = self.parse_expr(PRECEDENCE["and"] + 1)
            return UnaryOp("not", operand, tok.start, operand.end)
        return self.parse_primary()

    def parse_primary(self) -> Expr:
        tok = self.cur

        if tok.type is TokType.NUMBER:
            self.advance()
            value = float(tok.value) if "." in tok.value else int(tok.value)
            return Literal(value, tok.start, tok.end)

        if tok.type is TokType.DURATION:
            self.advance()
            return Literal(parse_duration(tok.value), tok.start, tok.end)

        if tok.type is TokType.STRING:
            self.advance()
            return Literal(tok.value, tok.start, tok.end)

        if tok.type is TokType.LPAREN:
            self.advance()
            inner = self.parse_expr()
            self.expect(TokType.RPAREN, "')'")
            return inner

        if self.at_keyword("true", "false"):
            self.advance()
            return Literal(tok.value.lower() == "true", tok.start, tok.end)

        if self.at_keyword("null"):
            self.advance()
            return Literal(None, tok.start, tok.end)

        if self.at_keyword("case"):
            return self.parse_case()

        if tok.type is TokType.IDENT:
            self.advance()
            if self.cur.type is TokType.LPAREN:
                return self.parse_call(tok)
            return ColumnRef(tok.value, tok.start, tok.end)

        raise SqlError(
            f"Expected a value or column but found {self._describe(tok)}.",
            tok.start, tok.end,
        )

    def parse_call(self, name_tok: Token) -> Expr:
        name = name_tok.value.lower()
        self.expect(TokType.LPAREN, "'('")

        distinct = False
        if self.at_keyword("distinct"):
            self.advance()
            distinct = True

        args: list[Expr] = []
        if self.cur.type is TokType.STAR:
            star_tok = self.advance()
            if name != "count":
                raise SqlError(
                    f"{name}(*) is not supported; only count(*) is.",
                    star_tok.start, star_tok.end,
                )
            # count(*) is represented as a zero-arg aggregate.
        elif self.cur.type is not TokType.RPAREN:
            args.append(self.parse_expr())
            while self.cur.type is TokType.COMMA:
                self.advance()
                args.append(self.parse_expr())

        close = self.expect(TokType.RPAREN, f"')' to close {name}(")

        if distinct:
            if name != "count":
                raise SqlError(
                    "DISTINCT is only supported inside count().",
                    name_tok.start, close.end,
                )
            return AggCall("count_distinct", tuple(args), True, name_tok.start, close.end)

        if name in AGGREGATES:
            return AggCall(name, tuple(args), False, name_tok.start, close.end)

        if name in SCALAR_FUNCS:
            return FuncCall(name, tuple(args), name_tok.start, close.end)

        known = sorted(AGGREGATES | SCALAR_FUNCS)
        raise SqlError(
            f"Unknown function {name!r}.",
            name_tok.start, close.end,
            hint=f"Available functions: {', '.join(known)}.",
        )

    def parse_case(self) -> Expr:
        start = self.expect_keyword("case").start
        whens: list[tuple[Expr, Expr]] = []
        while self.at_keyword("when"):
            self.advance()
            cond = self.parse_expr()
            self.expect_keyword("then")
            whens.append((cond, self.parse_expr()))
        if not whens:
            raise SqlError("CASE needs at least one WHEN branch.", start, self.cur.end)
        otherwise = None
        if self.at_keyword("else"):
            self.advance()
            otherwise = self.parse_expr()
        end = self.expect_keyword("end").end
        return Case(tuple(whens), otherwise, start, end)


def parse(src: str) -> Query:
    if not src.strip():
        raise SqlError("Empty query.", 0, 0, hint="Try: SELECT * FROM edits LIMIT 20")
    return Parser(src).parse()
