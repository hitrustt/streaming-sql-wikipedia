"""Store, sketch, ingest, and subscription-delta tests."""

import random
import time

import pytest

from riverbed.ingest import parse_event, _looks_like_ip
from riverbed.sketches import CountMinSketch, HyperLogLog, TDigest
from riverbed.store import EventStore
from riverbed.subscriptions import Subscription

from .conftest import make_row


# -- store ------------------------------------------------------------------

def test_append_and_recent_order(store):
    now = time.time()
    store.append_many([make_row(now - 3, title="a"), make_row(now - 2, title="b"),
                       make_row(now - 1, title="c")])
    assert [r["title"] for r in store.recent(3)] == ["c", "b", "a"]


def test_rows_outside_the_window_are_evicted():
    store = EventStore(window_seconds=60)
    now = time.time()
    store.append_many([make_row(now - 500), make_row(now - 400)])
    store.append(make_row(now))
    assert store.stats()["buffered_rows"] == 1
    assert store.total_ingested == 3
    assert store.base_offset == 2


def test_row_cap_is_enforced():
    store = EventStore(window_seconds=10_000, max_rows=100)
    now = time.time()
    store.append_many([make_row(now - i * 0.001) for i in range(500)])
    assert store.stats()["buffered_rows"] == 100


def test_snapshot_window_uses_binary_search(store):
    now = time.time()
    store.append_many([make_row(now - 300 + i) for i in range(300)])
    # The wall clock advances between building these rows and taking the
    # snapshot, so the row exactly on the boundary may fall either side.
    assert len(store.snapshot(60)) in (59, 60)
    assert len(store.snapshot(None)) == 300


def test_snapshot_window_boundary_is_exact(monkeypatch):
    """Same check with the clock frozen, so the boundary is unambiguous."""
    import riverbed.store as store_module

    base = time.time()
    monkeypatch.setattr(store_module.time, "time", lambda: base)

    store = EventStore()
    # Rows at base-300 .. base-1; a 60s window admits exactly the last 60.
    store.append_many([make_row(base - 300 + i) for i in range(300)])
    assert len(store.snapshot(60)) == 60


def test_recent_human_only_excludes_bots_wikidata_and_non_articles(store):
    now = time.time()
    store.append_many([
        make_row(now - 5, title="Real Article", user="Alice"),
        make_row(now - 4, title="Q12345", is_bot=True, project="wikidata"),
        make_row(now - 3, title="File:Photo.jpg", project="wikimedia", namespace=6),
        make_row(now - 2, title="Talk:Something", namespace=1),
        make_row(now - 1, title="Another Article", user="Bob"),
    ])
    titles = [r["title"] for r in store.recent(10, human_only=True)]
    assert titles == ["Another Article", "Real Article"]
    assert len(store.recent(10, human_only=False)) == 5


def test_recent_human_only_stops_once_it_has_enough(store):
    """The backwards scan must not walk the whole buffer to return a few rows."""
    now = time.time()
    store.append_many([make_row(now - 500 + i, title=f"Article{i}") for i in range(400)])
    rows = store.recent(3, human_only=True)
    assert [r["title"] for r in rows] == ["Article399", "Article398", "Article397"]


def test_missing_fields_fall_back_to_zero_values(store):
    store.append({"ts": time.time(), "lang": "en"})
    row = store.recent(1)[0]
    assert row["title"] == "" and row["delta"] == 0 and row["is_bot"] is False


def test_rollups_accumulate_per_minute(store):
    now = time.time()
    store.append_many([make_row(now, delta=100), make_row(now, delta=-40)])
    series = store.rollup_series(10)
    assert series[-1]["events"] == 2
    assert series[-1]["bytes_added"] == 100
    assert series[-1]["bytes_removed"] == 40


def test_rollup_retention_is_bounded():
    store = EventStore(rollup_minutes=5)
    now = time.time()
    store.append_many([make_row(now - i * 60) for i in range(30)])
    assert len(store.rollups) == 5


def test_stats_rate_uses_elapsed_time_not_a_flat_minute(store):
    """Regression: dividing by a flat 60s under-reports during the first minute."""
    store.started_at = time.time() - 10
    store.append_many([make_row(time.time()) for _ in range(100)])
    assert store.stats()["events_per_second"] == pytest.approx(10.0, rel=0.2)


# -- sketches ---------------------------------------------------------------

@pytest.mark.parametrize("n", [100, 1000, 50_000])
def test_hyperloglog_within_two_percent(n):
    hll = HyperLogLog(14)
    for i in range(n):
        hll.add(f"item{i}")
    assert abs(hll.count() - n) / n < 0.02


def test_hyperloglog_ignores_duplicates():
    hll = HyperLogLog(14)
    for _ in range(1000):
        hll.add("same")
    assert hll.count() == 1


def test_hyperloglog_merge_is_a_union():
    a, b = HyperLogLog(14), HyperLogLog(14)
    for i in range(5000):
        a.add(f"a{i}")
    for i in range(5000):
        b.add(f"a{i}" if i < 2500 else f"b{i}")
    a.merge(b)
    assert abs(a.count() - 7500) / 7500 < 0.03


def test_hyperloglog_rejects_mismatched_precision():
    with pytest.raises(ValueError):
        HyperLogLog(14).merge(HyperLogLog(12))


def test_count_min_never_underestimates():
    cms = CountMinSketch()
    truth = {}
    rng = random.Random(7)
    for _ in range(20_000):
        key = f"k{rng.randint(1, 500)}"
        truth[key] = truth.get(key, 0) + 1
        cms.add(key)
    assert all(cms.estimate(k) >= v for k, v in truth.items())


def test_count_min_finds_the_heavy_hitters():
    cms = CountMinSketch(k=20)
    for _ in range(10_000):
        cms.add("dominant")
    for i in range(5_000):
        cms.add(f"rare{i}")
    assert cms.heavy_hitters(1)[0][0] == "dominant"


def test_tdigest_quantiles_track_the_true_distribution():
    rng = random.Random(11)
    values = [rng.gauss(100, 15) for _ in range(20_000)]
    digest = TDigest()
    for v in values:
        digest.add(v)
    ordered = sorted(values)
    for q in (0.5, 0.9, 0.99):
        expected = ordered[int(q * len(ordered))]
        assert abs(digest.quantile(q) - expected) / abs(expected) < 0.05


def test_tdigest_on_empty_is_zero():
    assert TDigest().quantile(0.5) == 0.0


# -- ingest normalization ---------------------------------------------------

def wiki_event(**overrides):
    event = {
        "type": "edit",
        "server_name": "en.wikipedia.org",
        "title": "Test Page",
        "user": "Alice",
        "bot": False,
        "minor": False,
        "namespace": 0,
        "timestamp": 1700000000,
        "length": {"old": 100, "new": 250},
        "comment": "expanded",
        "meta": {"uri": "https://en.wikipedia.org/wiki/Test_Page", "dt": "2023-11-14T22:13:20Z"},
    }
    event.update(overrides)
    return event


def test_parse_event_computes_delta():
    row = parse_event(wiki_event())
    assert row["delta"] == 150 and row["new_len"] == 250


def test_parse_event_splits_language_and_project():
    row = parse_event(wiki_event(server_name="ja.wiktionary.org"))
    assert row["lang"] == "ja" and row["project"] == "wiktionary"


def test_non_language_sites_get_a_placeholder_language():
    row = parse_event(wiki_event(server_name="www.wikidata.org"))
    assert row["lang"] == "-" and row["project"] == "wikidata"


def test_page_creation_counts_whole_page_as_added():
    row = parse_event(wiki_event(type="new", length={"old": None, "new": 900}))
    assert row["delta"] == 900


def test_categorize_events_are_dropped():
    assert parse_event(wiki_event(type="categorize")) is None


def test_event_without_server_is_dropped():
    assert parse_event(wiki_event(server_name="")) is None


def test_missing_length_does_not_raise():
    row = parse_event(wiki_event(length=None))
    assert row["delta"] == 0


def test_falls_back_to_meta_dt_when_timestamp_is_absent():
    row = parse_event(wiki_event(timestamp=None))
    assert row["ts"] == pytest.approx(1700000000, abs=1)


def test_comment_is_truncated():
    row = parse_event(wiki_event(comment="x" * 1000))
    assert len(row["comment"]) == 280


@pytest.mark.parametrize("user,expected", [
    ("192.168.1.1", True),
    ("2001:db8::1", True),
    ("Alice", False),
    ("", False),
    ("1.2.3", False),
])
def test_anonymous_detection(user, expected):
    assert _looks_like_ip(user) is expected


# -- subscription deltas ----------------------------------------------------

def test_first_evaluation_is_a_full_snapshot(populated):
    sub = Subscription(id="s", sql="SELECT lang, count(*) AS n FROM edits GROUP BY lang")
    message = sub.evaluate(populated)
    assert message["full"] is True and len(message["rows"]) == 5


def test_unchanged_result_produces_no_deltas(populated):
    sub = Subscription(id="s", sql="SELECT lang, count(*) AS n FROM edits GROUP BY lang")
    sub.evaluate(populated)
    second = sub.evaluate(populated)
    assert second["full"] is False and second["deltas"] == []


def test_only_changed_rows_are_sent(populated):
    sub = Subscription(id="s", sql="SELECT lang, count(*) AS n FROM edits GROUP BY lang")
    sub.evaluate(populated)
    populated.append(make_row(time.time(), lang="en"))
    message = sub.evaluate(populated)
    assert [d["row"][0] for d in message["deltas"]] == ["en"]


def test_disappearing_group_is_removed(store):
    now = time.time()
    store.append(make_row(now, lang="en"))
    sub = Subscription(id="s", sql="SELECT lang, count(*) AS n FROM edits GROUP BY lang WINDOW 30s")
    sub.evaluate(store)
    store.columns["ts"][0] = now - 100  # Age the row out of the window.
    message = sub.evaluate(store)
    assert any(d["op"] == "remove" for d in message["deltas"])


def test_multi_key_rows_get_distinct_identities(store):
    """Regression: keying only on the first column merged distinct groups."""
    now = time.time()
    store.append_many([make_row(now, lang="en", title="Berlin"),
                       make_row(now, lang="de", title="Berlin")])
    sub = Subscription(id="s", sql="SELECT title, lang, count(*) AS n FROM edits GROUP BY title, lang")
    message = sub.evaluate(store)
    assert len(set(message["keys"])) == 2


def test_changing_the_query_shape_forces_a_full_resend(populated):
    sub = Subscription(id="s", sql="SELECT lang, count(*) AS n FROM edits GROUP BY lang")
    sub.evaluate(populated)
    sub.sql = "SELECT user, count(*) AS n FROM edits GROUP BY user"
    assert sub.evaluate(populated)["full"] is True


def test_broken_query_reports_an_error_and_backs_off(populated):
    sub = Subscription(id="s", sql="SELECT nope FROM edits")
    message = sub.evaluate(populated)
    assert message["type"] == "query_error"
    assert sub.next_run > time.time() + 1


def test_slow_queries_are_paced_further_apart(populated):
    sub = Subscription(id="s", sql="SELECT count(*) AS n FROM edits")
    sub.evaluate(populated)
    assert sub.tick_seconds == 1.0
