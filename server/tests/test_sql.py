"""Lexer, parser, planner, and executor tests."""

import time

import pytest

from riverbed.sql.ast import AggCall, BinaryOp, ColumnRef, Literal
from riverbed.sql.executor import run_query
from riverbed.sql.lexer import SqlError, TokType, tokenize
from riverbed.sql.parser import parse

from .conftest import make_row


# -- lexer ------------------------------------------------------------------

def test_tokenize_basic():
    kinds = [t.type for t in tokenize("SELECT lang FROM edits")]
    assert kinds[:4] == [TokType.KEYWORD, TokType.IDENT, TokType.KEYWORD, TokType.IDENT]


@pytest.mark.parametrize("text,seconds", [("30s", 30), ("5m", 300), ("2h", 7200), ("1d", 86400)])
def test_duration_literals(text, seconds):
    query = parse(f"SELECT count(*) FROM edits WINDOW {text}")
    assert query.window_seconds == seconds


def test_string_escape():
    tokens = tokenize("SELECT 'it''s' FROM edits")
    assert tokens[1].value == "it's"


def test_unterminated_string_points_at_the_quote():
    with pytest.raises(SqlError) as err:
        tokenize("SELECT 'oops FROM edits")
    assert err.value.start == 7


def test_comments_are_stripped():
    query = parse("SELECT lang -- a comment\nFROM edits")
    assert query.from_table == "edits"


def test_identifier_that_starts_with_a_duration_unit_is_not_a_duration():
    # 'minor' begins with 'm'; the lexer must not treat digits+letters greedily.
    query = parse("SELECT is_minor FROM edits")
    assert query.select[0].expr.name == "is_minor"


# -- parser -----------------------------------------------------------------

def test_precedence_binds_and_tighter_than_or():
    query = parse("SELECT * FROM edits WHERE is_bot OR is_anon AND is_minor")
    assert query.where.op == "or"
    assert query.where.right.op == "and"


def test_arithmetic_precedence():
    query = parse("SELECT delta + 2 * 3 AS x FROM edits")
    expr = query.select[0].expr
    assert expr.op == "+" and expr.right.op == "*"


def test_postfix_binds_to_operand_not_whole_expression():
    """Regression: `a LIKE 'x' AND b` must parse the AND, not stop at LIKE."""
    query = parse("SELECT * FROM edits WHERE title LIKE '%x%' AND is_bot = true")
    assert isinstance(query.where, BinaryOp)
    assert query.where.op == "and"


def test_not_in_list():
    query = parse("SELECT * FROM edits WHERE namespace NOT IN (0, 14)")
    assert query.where.negated is True
    assert len(query.where.values) == 2


def test_case_expression():
    query = parse("SELECT case when is_bot then 'b' else 'h' end AS who FROM edits")
    case = query.select[0].expr
    assert len(case.whens) == 1
    assert case.otherwise.value == "h"


def test_bare_alias_without_as():
    query = parse("SELECT count(*) edits FROM edits")
    assert query.select[0].alias == "edits"


def test_count_distinct_becomes_its_own_aggregate():
    query = parse("SELECT count(distinct user) FROM edits")
    agg = query.select[0].expr
    assert isinstance(agg, AggCall) and agg.name == "count_distinct"


def test_unknown_function_suggests_alternatives():
    with pytest.raises(SqlError) as err:
        parse("SELECT frobnicate(lang) FROM edits")
    assert "Available functions" in err.value.hint


def test_error_offsets_cover_the_offending_token():
    with pytest.raises(SqlError) as err:
        parse("SELECT * FROM edits WINDOW 5")
    assert err.value.start < err.value.end


def test_trailing_garbage_rejected():
    with pytest.raises(SqlError):
        parse("SELECT * FROM edits; DROP TABLE edits")


def test_empty_query_has_a_hint():
    with pytest.raises(SqlError) as err:
        parse("   ")
    assert "SELECT" in err.value.hint


# -- planner validation -----------------------------------------------------

def test_unknown_column_suggests_nearest(populated):
    with pytest.raises(SqlError) as err:
        run_query("SELECT langg FROM edits", populated)
    assert "lang" in err.value.hint


def test_bare_column_in_grouped_select_is_rejected(populated):
    with pytest.raises(SqlError) as err:
        run_query("SELECT title, count(*) FROM edits GROUP BY lang", populated)
    assert "GROUP BY" in err.value.message


def test_grouping_by_alias_of_expression_allows_its_columns(populated):
    """Regression: `GROUP BY who` where who aliases a CASE over is_bot."""
    result = run_query(
        "SELECT case when is_bot then 'bot' else 'human' end AS who, count(*) AS n "
        "FROM edits GROUP BY who ORDER BY n DESC",
        populated,
    )
    assert {r[0] for r in result.rows} == {"bot", "human"}
    assert sum(r[1] for r in result.rows) == 1000


def test_aggregate_in_where_is_rejected(populated):
    with pytest.raises(SqlError):
        run_query("SELECT count(*) FROM edits WHERE count(*) > 1", populated)


def test_nested_aggregates_rejected(populated):
    with pytest.raises(SqlError):
        run_query("SELECT sum(count(delta)) FROM edits", populated)


def test_window_beyond_retention_is_rejected(populated):
    with pytest.raises(SqlError) as err:
        run_query("SELECT count(*) FROM edits WINDOW 1d", populated)
    assert "retention" in err.value.message


def test_unknown_table(populated):
    with pytest.raises(SqlError):
        run_query("SELECT count(*) FROM pages", populated)


# -- execution --------------------------------------------------------------

def test_count_matches_row_count(populated):
    result = run_query("SELECT count(*) AS n FROM edits", populated)
    assert result.rows == [[1000]]


def test_where_filters(populated):
    total = run_query("SELECT count(*) AS n FROM edits", populated).rows[0][0]
    bots = run_query("SELECT count(*) AS n FROM edits WHERE is_bot", populated).rows[0][0]
    humans = run_query("SELECT count(*) AS n FROM edits WHERE NOT is_bot", populated).rows[0][0]
    assert bots + humans == total
    assert bots == 250  # every 4th row


def test_group_by_partitions_all_rows(populated):
    result = run_query(
        "SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY n DESC", populated
    )
    assert len(result.rows) == 5
    assert sum(r[1] for r in result.rows) == 1000


def test_multi_key_group_by(populated):
    result = run_query(
        "SELECT lang, namespace, count(*) AS n FROM edits GROUP BY lang, namespace", populated
    )
    assert sum(r[2] for r in result.rows) == 1000
    assert result.key_columns == 2


def test_order_by_desc_then_limit(populated):
    result = run_query(
        "SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY n DESC LIMIT 2", populated
    )
    assert len(result.rows) == 2
    assert result.rows[0][1] >= result.rows[1][1]
    assert result.truncated is True


def test_sum_and_avg_agree(populated):
    row = run_query(
        "SELECT sum(delta) AS s, avg(delta) AS a, count(*) AS n FROM edits", populated
    ).rows[0]
    assert abs(row[0] / row[2] - row[1]) < 0.01


def test_min_max(populated):
    row = run_query("SELECT min(delta) AS lo, max(delta) AS hi FROM edits", populated).rows[0]
    assert row[0] <= row[1]


def test_count_distinct_is_close(populated):
    # 25 distinct users; HLL should be exact at this cardinality.
    result = run_query("SELECT count(distinct user) AS u FROM edits", populated)
    assert abs(result.rows[0][0] - 25) <= 1


def test_percentile_is_ordered(populated):
    row = run_query(
        "SELECT percentile(delta, 10) AS p10, percentile(delta, 50) AS p50, "
        "percentile(delta, 90) AS p90 FROM edits", populated
    ).rows[0]
    assert row[0] <= row[1] <= row[2]


def test_top_k_returns_pairs(populated):
    result = run_query("SELECT top_k(lang, 3) AS langs FROM edits", populated)
    top = result.rows[0][0]
    assert len(top) == 3
    assert all(len(pair) == 2 for pair in top)


def test_like_patterns(populated):
    contains = run_query(
        "SELECT count(*) AS n FROM edits WHERE comment LIKE '%vandal%'", populated
    ).rows[0][0]
    prefix = run_query(
        "SELECT count(*) AS n FROM edits WHERE comment LIKE 'reverted%'", populated
    ).rows[0][0]
    assert contains == prefix > 0


def test_like_is_case_insensitive(populated):
    assert run_query(
        "SELECT count(*) AS n FROM edits WHERE comment LIKE '%VANDAL%'", populated
    ).rows[0][0] > 0


def test_in_list(populated):
    result = run_query(
        "SELECT count(*) AS n FROM edits WHERE lang IN ('en', 'de')", populated
    )
    assert result.rows[0][0] == 400


def test_scalar_query_returns_newest_first(populated):
    result = run_query("SELECT ts FROM edits LIMIT 5", populated)
    timestamps = [r[0] for r in result.rows]
    assert timestamps == sorted(timestamps, reverse=True)


def test_star_expands_to_all_columns(populated):
    from riverbed.schema import COLUMNS
    result = run_query("SELECT * FROM edits LIMIT 1", populated)
    assert result.columns == [c.name for c in COLUMNS]


def test_default_limit_is_noted(populated):
    result = run_query("SELECT title FROM edits", populated)
    assert len(result.rows) == 200
    assert any("LIMIT" in note for note in result.notes)


def test_aggregate_over_empty_store_returns_zero(store):
    result = run_query("SELECT count(*) AS n FROM edits", store)
    assert result.rows == [[0]]


def test_grouped_query_over_empty_store_returns_no_rows(store):
    result = run_query("SELECT lang, count(*) FROM edits GROUP BY lang", store)
    assert result.rows == []


def test_window_restricts_rows(store):
    now = time.time()
    store.append_many([make_row(now - 400), make_row(now - 10), make_row(now - 5)])
    assert run_query("SELECT count(*) AS n FROM edits WINDOW 60s", store).rows[0][0] == 2
    assert run_query("SELECT count(*) AS n FROM edits", store).rows[0][0] == 3


def test_division_by_zero_yields_zero_not_a_crash(populated):
    result = run_query("SELECT count(*) / 0 AS x FROM edits", populated)
    assert result.rows[0][0] == 0


def test_comparing_string_to_number_gives_a_real_error(populated):
    with pytest.raises(SqlError) as err:
        run_query("SELECT count(*) FROM edits WHERE lang > 5", populated)
    assert "compare" in err.value.message.lower()


def test_mixed_type_sort_does_not_crash(populated):
    result = run_query(
        "SELECT case when is_bot then 1 else 'none' end AS mixed, count(*) AS n "
        "FROM edits GROUP BY mixed ORDER BY mixed", populated
    )
    assert len(result.rows) == 2


def test_identical_aggregates_are_computed_once(populated):
    """`count(*)` in both SELECT and ORDER BY should share one accumulator."""
    from riverbed.sql.planner import plan
    scan = populated.snapshot(None)
    compiled = plan(parse(
        "SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY count(*) DESC"
    ), scan.columns, time.time())
    assert len(compiled.aggs) == 1


def test_where_conjuncts_are_reordered_cheapest_first():
    from riverbed.sql.planner import _reorder_where, _split_conjuncts, _cost
    query = parse("SELECT * FROM edits WHERE comment LIKE '%x%' AND is_bot = true")
    reordered = _reorder_where(query.where)
    costs = [_cost(part) for part in _split_conjuncts(reordered)]
    assert costs == sorted(costs)


def test_constant_folding():
    from riverbed.sql.planner import _fold
    folded = _fold(parse("SELECT * FROM edits WHERE delta > 2 * 50").where)
    assert isinstance(folded.right, Literal) and folded.right.value == 100


def test_scanned_and_matched_are_reported(populated):
    result = run_query("SELECT count(*) AS n FROM edits WHERE is_bot", populated)
    assert result.scanned == 1000
    assert result.matched == 250
