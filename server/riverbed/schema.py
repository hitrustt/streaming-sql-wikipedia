"""The `edits` table: the shape every Wikimedia event is normalized into.

The engine is deliberately built around one wide, flat, strongly-typed table.
A streaming engine that has to reason about joins is a much larger project, and
the interesting problems here (windowing, incremental aggregation, high
cardinality) all live on a single stream. Keeping the schema flat also means the
column store can be a plain list-per-column with no nesting.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ColType(str, Enum):
    INT = "int"
    FLOAT = "float"
    STRING = "string"
    BOOL = "bool"
    # Unix seconds. Separate from INT so the planner can special-case time
    # predicates and the UI can format it.
    TIMESTAMP = "timestamp"


@dataclass(frozen=True)
class Column:
    name: str
    type: ColType
    doc: str
    #: Surfaced in the UI's clickable filter list. High-cardinality columns
    #: (title, user) are excluded because a dropdown of 2M titles is useless.
    facetable: bool = False


COLUMNS: tuple[Column, ...] = (
    Column("ts", ColType.TIMESTAMP, "When the edit was saved (UTC)."),
    Column("wiki", ColType.STRING, "Wiki domain, e.g. en.wikipedia.org.", facetable=True),
    Column("lang", ColType.STRING, "Language code parsed from the domain.", facetable=True),
    Column("project", ColType.STRING, "wikipedia, wiktionary, commons, wikidata, ...", facetable=True),
    Column("type", ColType.STRING, "edit, new, categorize, or log.", facetable=True),
    Column("title", ColType.STRING, "Page title."),
    Column("user", ColType.STRING, "Editor username or IP for anonymous edits."),
    Column("is_bot", ColType.BOOL, "True if the edit was flagged as a bot edit.", facetable=True),
    Column("is_anon", ColType.BOOL, "True if the editor was not logged in.", facetable=True),
    Column("is_minor", ColType.BOOL, "True if flagged as a minor edit.", facetable=True),
    Column("namespace", ColType.INT, "MediaWiki namespace id (0 = article).", facetable=True),
    Column("delta", ColType.INT, "Bytes added (negative for removals)."),
    Column("new_len", ColType.INT, "Page size in bytes after the edit."),
    Column("comment", ColType.STRING, "Edit summary written by the editor."),
    Column("uri", ColType.STRING, "Canonical URL of the edited page."),
)

COLUMNS_BY_NAME: dict[str, Column] = {c.name: c for c in COLUMNS}

NUMERIC_TYPES = {ColType.INT, ColType.FLOAT, ColType.TIMESTAMP}


def is_numeric(t: ColType) -> bool:
    return t in NUMERIC_TYPES


#: Zero values used when a column is missing from an event. Chosen so that
#: aggregates over absent data stay sane rather than raising.
EMPTY: dict[ColType, Any] = {
    ColType.INT: 0,
    ColType.FLOAT: 0.0,
    ColType.STRING: "",
    ColType.BOOL: False,
    ColType.TIMESTAMP: 0,
}
