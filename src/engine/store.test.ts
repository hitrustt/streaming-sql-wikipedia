import { afterEach, describe, expect, it, vi } from 'vitest';
import { looksLikeIp, parseEvent } from './ingest';
import type { EditRow } from './schema';
import { EventStore } from './store';
import { Subscription } from './subscriptions';
import { makeRow } from './sql.test';

afterEach(() => {
  vi.useRealTimers();
});

// -- store ------------------------------------------------------------------

describe('EventStore', () => {
  it('returns recent rows newest first', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany([
      makeRow(base - 3, { title: 'a' }),
      makeRow(base - 2, { title: 'b' }),
      makeRow(base - 1, { title: 'c' }),
    ]);
    expect(store.recent(3).map((r) => r.title)).toEqual(['c', 'b', 'a']);
  });

  it('evicts rows outside the window', () => {
    const store = new EventStore(60);
    const base = Date.now() / 1000;
    store.appendMany([makeRow(base - 500), makeRow(base - 400)]);
    store.append(makeRow(base));
    expect(store.stats().bufferedRows).toBe(1);
    expect(store.totalIngested).toBe(3);
    expect(store.baseOffset).toBe(2);
  });

  it('enforces the row cap', () => {
    const store = new EventStore(10_000, 100);
    const base = Date.now() / 1000;
    store.appendMany(Array.from({ length: 500 }, (_, i) => makeRow(base - i * 0.001)));
    expect(store.stats().bufferedRows).toBe(100);
  });

  it('windows a snapshot by time', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany(Array.from({ length: 300 }, (_, i) => makeRow(base - 300 + i)));
    // The clock advances between building rows and snapshotting, so the row on
    // the boundary may fall either side.
    expect(store.snapshot(60).length).toBeGreaterThanOrEqual(59);
    expect(store.snapshot(60).length).toBeLessThanOrEqual(61);
    expect(store.snapshot(null).length).toBe(300);
  });

  it('windows exactly with the clock frozen', () => {
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const store = new EventStore();
    const seconds = base / 1000;
    store.appendMany(Array.from({ length: 300 }, (_, i) => makeRow(seconds - 300 + i)));
    expect(store.snapshot(60).length).toBe(60);
  });

  it('fills missing fields with zero values', () => {
    const store = new EventStore();
    store.appendMany([{ ts: Date.now() / 1000, lang: 'en' } as EditRow]);
    const row = store.recent(1)[0]!;
    expect(row.title).toBe('');
    expect(row.delta).toBe(0);
    expect(row.is_bot).toBe(false);
  });

  it('accumulates rollups per minute', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany([makeRow(base, { delta: 100 }), makeRow(base, { delta: -40 })]);
    const series = store.rollupSeries(10);
    const last = series[series.length - 1]!;
    expect(last.events).toBe(2);
    expect(last.bytesAdded).toBe(100);
    expect(last.bytesRemoved).toBe(40);
  });

  it('bounds rollup retention', () => {
    const store = new EventStore(15 * 60, 80_000, 5);
    const base = Date.now() / 1000;
    store.appendMany(Array.from({ length: 30 }, (_, i) => makeRow(base - i * 60)));
    expect(store.rollupSeries(1000).length).toBe(5);
  });

  it('computes rate over the span of event time covered', () => {
    // Regression: a flat 60s divisor under-reports during the first minute.
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const store = new EventStore();
    const seconds = base / 1000;
    // 100 events spread over the preceding 10 seconds.
    store.appendMany(Array.from({ length: 100 }, (_, i) => makeRow(seconds - 10 + i * 0.1)));
    expect(store.stats().eventsPerSecond).toBeCloseTo(10, 0);
  });

  it('does not over-report the rate while backfilling', () => {
    // Regression: replaying 90s of history in ~2s made the header read 600/s.
    // Rate must reflect the events' own timestamps, not how fast they arrived.
    const base = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const store = new EventStore();
    const seconds = base / 1000;
    // 30 events per second of event time, all delivered in one burst.
    store.appendMany(Array.from({ length: 1800 }, (_, i) => makeRow(seconds - 60 + i / 30)));

    const rate = store.stats().eventsPerSecond;
    expect(rate).toBeGreaterThan(20);
    expect(rate).toBeLessThan(45);
  });

  it('filters the feed to human article edits', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany([
      makeRow(base - 5, { title: 'Real Article', user: 'Alice' }),
      makeRow(base - 4, { title: 'Q12345', is_bot: true, project: 'wikidata' }),
      makeRow(base - 3, { title: 'File:Photo.jpg', project: 'wikimedia', namespace: 6 }),
      makeRow(base - 2, { title: 'Talk:Something', namespace: 1 }),
      makeRow(base - 1, { title: 'Another Article', user: 'Bob' }),
    ]);
    expect(store.recent(10, true).map((r) => r.title)).toEqual(['Another Article', 'Real Article']);
    expect(store.recent(10, false).length).toBe(5);
  });

  it('stops the feed scan once it has enough rows', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany(Array.from({ length: 400 }, (_, i) => makeRow(base - 400 + i, {
      title: `Article${i}`,
    })));
    expect(store.recent(3, true).map((r) => r.title))
      .toEqual(['Article399', 'Article398', 'Article397']);
  });
});

// -- ingest normalization ---------------------------------------------------

function wikiEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'edit',
    server_name: 'en.wikipedia.org',
    title: 'Test Page',
    user: 'Alice',
    bot: false,
    minor: false,
    namespace: 0,
    timestamp: 1700000000,
    length: { old: 100, new: 250 },
    comment: 'expanded',
    meta: { uri: 'https://en.wikipedia.org/wiki/Test_Page', dt: '2023-11-14T22:13:20Z', id: 'abc' },
    ...overrides,
  };
}

describe('parseEvent', () => {
  it('computes the byte delta', () => {
    const row = parseEvent(wikiEvent())!;
    expect(row.delta).toBe(150);
    expect(row.new_len).toBe(250);
  });

  it('splits language and project from the domain', () => {
    const row = parseEvent(wikiEvent({ server_name: 'ja.wiktionary.org' }))!;
    expect(row.lang).toBe('ja');
    expect(row.project).toBe('wiktionary');
  });

  it('labels non-language sites with a placeholder language', () => {
    const row = parseEvent(wikiEvent({ server_name: 'www.wikidata.org' }))!;
    expect(row.lang).toBe('-');
    expect(row.project).toBe('wikidata');
  });

  it('counts a whole new page as added', () => {
    const row = parseEvent(wikiEvent({ type: 'new', length: { old: null, new: 900 } }))!;
    expect(row.delta).toBe(900);
  });

  it('drops categorize events', () => {
    expect(parseEvent(wikiEvent({ type: 'categorize' }))).toBeNull();
  });

  it('drops events with no server', () => {
    expect(parseEvent(wikiEvent({ server_name: '' }))).toBeNull();
  });

  it('survives a missing length', () => {
    expect(parseEvent(wikiEvent({ length: null }))!.delta).toBe(0);
  });

  it('falls back to meta.dt when timestamp is absent', () => {
    const row = parseEvent(wikiEvent({ timestamp: undefined }))!;
    expect(row.ts).toBeCloseTo(1700000000, 0);
  });

  it('truncates long comments', () => {
    expect(String(parseEvent(wikiEvent({ comment: 'x'.repeat(1000) }))!.comment).length).toBe(280);
  });

  it.each([
    ['192.168.1.1', true],
    ['2001:db8::1', true],
    ['Alice', false],
    ['', false],
    ['1.2.3', false],
  ])('detects anonymous editor %s', (user, expected) => {
    expect(looksLikeIp(user)).toBe(expected);
  });

  it('marks IP editors as anonymous', () => {
    expect(parseEvent(wikiEvent({ user: '10.0.0.1' }))!.is_anon).toBe(true);
    expect(parseEvent(wikiEvent({ user: 'Alice' }))!.is_anon).toBe(false);
  });
});

// -- subscription deltas ----------------------------------------------------

function populated(): EventStore {
  const store = new EventStore();
  const base = Date.now() / 1000;
  const langs = ['en', 'de', 'fr', 'ja', 'es'];
  store.appendMany(Array.from({ length: 500 }, (_, i) =>
    makeRow(base - 200 + i * 0.4, { lang: langs[i % langs.length]!, user: `user${i % 20}` })));
  return store;
}

describe('Subscription', () => {
  it('sends a full snapshot first', () => {
    const sub = new Subscription('s', 'SELECT lang, count(*) AS n FROM edits GROUP BY lang');
    const message = sub.evaluate(populated());
    expect(message.type).toBe('result');
    expect(message.type === 'result' && message.full).toBe(true);
    expect(message.type === 'result' && message.rows!.length).toBe(5);
  });

  it('sends no deltas when nothing changed', () => {
    const store = populated();
    const sub = new Subscription('s', 'SELECT lang, count(*) AS n FROM edits GROUP BY lang');
    sub.evaluate(store);
    const second = sub.evaluate(store);
    expect(second.type === 'result' && second.full).toBe(false);
    expect(second.type === 'result' && second.deltas).toEqual([]);
  });

  it('sends only the rows that changed', () => {
    const store = populated();
    const sub = new Subscription('s', 'SELECT lang, count(*) AS n FROM edits GROUP BY lang');
    sub.evaluate(store);
    store.append(makeRow(Date.now() / 1000, { lang: 'en' }));
    const message = sub.evaluate(store);
    expect(message.type === 'result' && message.deltas!.map((d) => d.row![0])).toEqual(['en']);
  });

  it('removes a group that disappears', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.append(makeRow(base, { lang: 'en' }));
    const sub = new Subscription(
      's', 'SELECT lang, count(*) AS n FROM edits GROUP BY lang WINDOW 30s',
    );
    sub.evaluate(store);
    store.columns.ts![0] = base - 100; // Age the row out of the window.
    const message = sub.evaluate(store);
    expect(message.type === 'result' && message.deltas!.some((d) => d.op === 'remove')).toBe(true);
  });

  it('gives multi-key rows distinct identities', () => {
    const store = new EventStore();
    const base = Date.now() / 1000;
    store.appendMany([
      makeRow(base, { lang: 'en', title: 'Berlin' }),
      makeRow(base, { lang: 'de', title: 'Berlin' }),
    ]);
    const sub = new Subscription(
      's', 'SELECT title, lang, count(*) AS n FROM edits GROUP BY title, lang',
    );
    const message = sub.evaluate(store);
    expect(message.type === 'result' && new Set(message.keys!).size).toBe(2);
  });

  it('resends in full when the query shape changes', () => {
    const store = populated();
    const sub = new Subscription('s', 'SELECT lang, count(*) AS n FROM edits GROUP BY lang');
    sub.evaluate(store);
    sub.sql = 'SELECT user, count(*) AS n FROM edits GROUP BY user';
    const message = sub.evaluate(store);
    expect(message.type === 'result' && message.full).toBe(true);
  });

  it('reports a broken query as an error', () => {
    const message = new Subscription('s', 'SELECT nope FROM edits').evaluate(populated());
    expect(message.type).toBe('queryError');
    expect(message.type === 'queryError' && message.error.message).toContain("Unknown column 'nope'");
  });

  it('lists available columns when no close match exists', () => {
    const message = new Subscription('s', 'SELECT zzzzzzzz FROM edits').evaluate(populated());
    expect(message.type === 'queryError' && message.error.hint).toContain('Available columns');
  });

  it('does not treat an unchanged top_k as a change', () => {
    // Regression: nested arrays compared by reference made every tick a delta.
    const store = populated();
    const sub = new Subscription('s', 'SELECT top_k(lang, 3) AS langs FROM edits');
    sub.evaluate(store);
    const second = sub.evaluate(store);
    expect(second.type === 'result' && second.deltas).toEqual([]);
  });
});
