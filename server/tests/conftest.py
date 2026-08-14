import random
import time

import pytest

from riverbed.store import EventStore

LANGS = ["en", "de", "fr", "ja", "es"]


def make_row(ts: float, **overrides):
    row = {
        "ts": ts,
        "wiki": "en.wikipedia.org",
        "lang": "en",
        "project": "wikipedia",
        "type": "edit",
        "title": "Page",
        "user": "alice",
        "is_bot": False,
        "is_anon": False,
        "is_minor": False,
        "namespace": 0,
        "delta": 10,
        "new_len": 1000,
        "comment": "",
        "uri": "",
    }
    row.update(overrides)
    return row


@pytest.fixture
def store():
    return EventStore()


@pytest.fixture
def populated(store):
    """A deterministic store: 1000 rows over the last 500 seconds."""
    rng = random.Random(1234)
    now = time.time()
    rows = []
    for i in range(1000):
        rows.append(make_row(
            now - 500 + i * 0.5,
            lang=LANGS[i % len(LANGS)],
            title=f"Page{i % 50}",
            user=f"user{i % 25}",
            is_bot=(i % 4 == 0),
            is_anon=(i % 7 == 0),
            namespace=0 if i % 3 else 14,
            delta=rng.randint(-500, 500),
            comment="reverted vandalism" if i % 11 == 0 else "copyedit",
        ))
    store.append_many(rows)
    return store
