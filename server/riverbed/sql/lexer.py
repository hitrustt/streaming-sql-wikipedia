"""Hand-written tokenizer for the Riverbed SQL dialect.

Deliberately not a regex soup: a single left-to-right scan that tracks byte
offsets, so parse errors can point at the exact character the user typed. The
frontend underlines the offending token using these offsets, which is the
difference between "syntax error" and an error message someone can act on.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto


class TokType(Enum):
    IDENT = auto()
    NUMBER = auto()
    STRING = auto()
    KEYWORD = auto()
    OP = auto()
    LPAREN = auto()
    RPAREN = auto()
    COMMA = auto()
    STAR = auto()
    DURATION = auto()  # 30s, 5m, 2h, 1d
    EOF = auto()


KEYWORDS = {
    "select", "from", "where", "group", "by", "order", "limit", "window",
    "and", "or", "not", "as", "asc", "desc", "distinct", "like", "in",
    "is", "null", "true", "false", "case", "when", "then", "else", "end",
}

# Longest-first so that '>=' is matched before '>'.
OPERATORS = (
    ">=", "<=", "!=", "<>", "=", "<", ">", "+", "-", "*", "/", "%", "||",
)

DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


@dataclass(frozen=True)
class Token:
    type: TokType
    value: str
    start: int
    end: int

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Token({self.type.name}, {self.value!r})"


class SqlError(Exception):
    """A user-facing SQL error carrying source offsets for underlining.

    Every error the user can trigger by typing goes through this class, so the
    API layer can return a structured error instead of a stack trace.
    """

    def __init__(self, message: str, start: int = 0, end: int = 0, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.start = start
        self.end = end
        self.hint = hint

    def to_dict(self) -> dict:
        return {
            "message": self.message,
            "start": self.start,
            "end": self.end,
            "hint": self.hint,
        }


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    n = len(src)

    while i < n:
        c = src[i]

        # Whitespace
        if c in " \t\r\n":
            i += 1
            continue

        # Line comments
        if src.startswith("--", i):
            j = src.find("\n", i)
            i = n if j == -1 else j + 1
            continue

        # Single-quoted string literals, '' escapes an embedded quote.
        if c == "'":
            j = i + 1
            buf: list[str] = []
            while True:
                if j >= n:
                    raise SqlError("Unterminated string literal.", i, n,
                                   hint="Add a closing single quote.")
                if src[j] == "'":
                    if j + 1 < n and src[j + 1] == "'":
                        buf.append("'")
                        j += 2
                        continue
                    break
                buf.append(src[j])
                j += 1
            tokens.append(Token(TokType.STRING, "".join(buf), i, j + 1))
            i = j + 1
            continue

        # Numbers, and durations like 5m / 30s / 2h / 1d.
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            j = i
            seen_dot = False
            while j < n and (src[j].isdigit() or (src[j] == "." and not seen_dot)):
                if src[j] == ".":
                    seen_dot = True
                j += 1
            # A bare unit letter immediately after digits makes it a duration.
            if not seen_dot and j < n and src[j] in DURATION_UNITS:
                is_unit_end = j + 1 >= n or not (src[j + 1].isalnum() or src[j + 1] == "_")
                if is_unit_end:
                    tokens.append(Token(TokType.DURATION, src[i:j + 1], i, j + 1))
                    i = j + 1
                    continue
            tokens.append(Token(TokType.NUMBER, src[i:j], i, j))
            i = j
            continue

        # Identifiers and keywords.
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_"):
                j += 1
            word = src[i:j]
            kind = TokType.KEYWORD if word.lower() in KEYWORDS else TokType.IDENT
            tokens.append(Token(kind, word, i, j))
            i = j
            continue

        # Double-quoted identifiers, for column names that collide with keywords.
        if c == '"':
            j = src.find('"', i + 1)
            if j == -1:
                raise SqlError("Unterminated quoted identifier.", i, n)
            tokens.append(Token(TokType.IDENT, src[i + 1:j], i, j + 1))
            i = j + 1
            continue

        if c == "(":
            tokens.append(Token(TokType.LPAREN, c, i, i + 1))
            i += 1
            continue
        if c == ")":
            tokens.append(Token(TokType.RPAREN, c, i, i + 1))
            i += 1
            continue
        if c == ",":
            tokens.append(Token(TokType.COMMA, c, i, i + 1))
            i += 1
            continue

        matched = next((op for op in OPERATORS if src.startswith(op, i)), None)
        if matched:
            # '*' is its own token type so `SELECT *` and `a * b` can be told
            # apart by the parser without lookbehind hacks.
            ttype = TokType.STAR if matched == "*" else TokType.OP
            tokens.append(Token(ttype, matched, i, i + len(matched)))
            i += len(matched)
            continue

        raise SqlError(f"Unexpected character {c!r}.", i, i + 1)

    tokens.append(Token(TokType.EOF, "", n, n))
    return tokens


def parse_duration(text: str) -> int:
    """'5m' -> 300. Assumes the lexer already validated the shape."""
    return int(text[:-1]) * DURATION_UNITS[text[-1]]
