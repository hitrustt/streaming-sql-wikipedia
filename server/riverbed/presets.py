"""Curated queries shown as one-click chips in the UI.

These carry a disproportionate amount of the product's weight: a visitor who
never types anything should still see the engine do something interesting.

**On the default filter.** The raw firehose is roughly 58% bot edits, and only a
third of it touches Wikipedia itself -- the rest is Wikidata (opaque item ids
like `Q141053470`), Commons file uploads, and sister projects. Unfiltered, the
stream reads as machine noise: pages of numeric identifiers in no language.

So most presets restrict to `is_bot = false AND project = 'wikipedia' AND
namespace = 0`: human editors, working on actual encyclopedia articles. That is
~13% of the volume, still several edits a second, and every row is a real title
a person can recognize. The bot traffic is not hidden -- it is the subject of
its own question, where it is genuinely interesting rather than merely loud.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Human editors, real articles, Wikipedia proper. The reason is documented at
#: module level; it is applied per-preset rather than globally so that any
#: filter a visitor sees is one they could have typed themselves.
HUMAN_ARTICLES = "is_bot = false AND project = 'wikipedia' AND namespace = 0"


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    description: str
    sql: str
    #: How the frontend should draw it.
    viz: str  # "bar" | "table" | "stat" | "line"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "sql": self.sql.strip(),
            "viz": self.viz,
        }


PRESETS: tuple[Preset, ...] = (
    Preset(
        id="hot_pages",
        label="What's being edited most",
        description="Articles people are editing repeatedly right now — often breaking news or a disagreement.",
        viz="table",
        sql=f"""
SELECT title, lang, count(*) AS edits, count(distinct user) AS editors
FROM edits
WHERE {HUMAN_ARTICLES}
GROUP BY title, lang
ORDER BY edits DESC
LIMIT 15
WINDOW 15m
""",
    ),
    Preset(
        id="busiest_langs",
        label="Busiest languages",
        description="Which language editions of Wikipedia people are writing in right now.",
        viz="bar",
        sql=f"""
SELECT lang, count(*) AS edits
FROM edits
WHERE {HUMAN_ARTICLES}
GROUP BY lang
ORDER BY edits DESC
LIMIT 12
WINDOW 10m
""",
    ),
    Preset(
        id="new_pages",
        label="Brand new articles",
        description="Encyclopedia articles that did not exist a few minutes ago.",
        viz="table",
        sql="""
SELECT title, lang, user, new_len AS bytes
FROM edits
WHERE type = 'new' AND is_bot = false AND project = 'wikipedia' AND namespace = 0
ORDER BY ts DESC
LIMIT 20
WINDOW 30m
""",
    ),
    Preset(
        id="big_removals",
        label="Largest deletions",
        description="The biggest chunks of text removed by a person — vandalism, blanking, or cleanup.",
        viz="table",
        sql=f"""
SELECT title, lang, user, delta, comment
FROM edits
WHERE {HUMAN_ARTICLES} AND delta < -1000
ORDER BY delta ASC
LIMIT 15
WINDOW 30m
""",
    ),
    Preset(
        id="reverts",
        label="Reverts and undos",
        description="Edits that undo someone else's work — the visible edge of Wikipedia's disputes.",
        viz="table",
        sql=f"""
SELECT title, lang, user, comment
FROM edits
WHERE {HUMAN_ARTICLES}
  AND (comment LIKE '%revert%' OR comment LIKE '%undo%' OR comment LIKE '%rvv%')
ORDER BY ts DESC
LIMIT 15
WINDOW 30m
""",
    ),
    Preset(
        id="busiest_editors",
        label="Busiest editors",
        description="The people doing the most work on Wikipedia in the last fifteen minutes.",
        viz="table",
        sql=f"""
SELECT user, count(*) AS edits, count(distinct title) AS pages, sum(delta) AS net_bytes
FROM edits
WHERE {HUMAN_ARTICLES}
GROUP BY user
ORDER BY edits DESC
LIMIT 15
WINDOW 15m
""",
    ),
    Preset(
        id="anon_activity",
        label="Logged-out editors",
        description="Anyone can edit Wikipedia without an account. This is how much of it they do.",
        viz="bar",
        sql=f"""
SELECT lang, count(*) AS anon_edits
FROM edits
WHERE {HUMAN_ARTICLES} AND is_anon
GROUP BY lang
ORDER BY anon_edits DESC
LIMIT 10
WINDOW 15m
""",
    ),
    Preset(
        id="edit_size",
        label="How big is a typical edit?",
        description="Most edits are tiny; a few are enormous. Percentiles estimated with a t-digest.",
        viz="stat",
        sql=f"""
SELECT count(*) AS edits,
       percentile(delta, 50) AS typical_bytes,
       percentile(delta, 95) AS large_bytes,
       percentile(delta, 99) AS huge_bytes,
       max(delta) AS largest
FROM edits
WHERE {HUMAN_ARTICLES} AND type = 'edit'
WINDOW 10m
""",
    ),
    # --- the wider firehose, where the machines are the point ---------------
    Preset(
        id="bots_vs_humans",
        label="Bots vs humans",
        description="Most of Wikimedia's activity is automated. This is the split across everything.",
        viz="bar",
        sql="""
SELECT case when is_bot then 'bot' else 'human' end AS editor,
       count(*) AS edits,
       count(distinct user) AS accounts
FROM edits
GROUP BY editor
ORDER BY edits DESC
WINDOW 10m
""",
    ),
    Preset(
        id="projects",
        label="Beyond Wikipedia",
        description="Wikidata, Commons, Wiktionary and more — all editable, all in this stream.",
        viz="bar",
        sql="""
SELECT project, count(*) AS edits
FROM edits
GROUP BY project
ORDER BY edits DESC
LIMIT 10
WINDOW 10m
""",
    ),
)

PRESETS_BY_ID = {p.id: p for p in PRESETS}

#: Runs behind the always-on header stats. Deliberately unfiltered: the header
#: reports the true scale of the pipeline, and it is labelled as all activity.
HEADLINE_SQL = """
SELECT count(*) AS edits,
       count(distinct user) AS editors,
       count(distinct title) AS pages,
       sum(delta) AS net_bytes
FROM edits
WINDOW 5m
"""
