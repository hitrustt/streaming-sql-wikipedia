import { beforeEach, describe, expect, it } from 'vitest';
import { runQuery } from './executor';
import { SqlError, tokenize } from './lexer';
import { parse } from './parser';
import { cost, fold, plan, reorderWhere, splitConjuncts } from './planner';
import type { EditRow } from './schema';
import { EventStore } from './store';

const LANGS = ['en', 'de', 'fr', 'ja', 'es'];

export function makeRow(ts: number, overrides: Partial<EditRow> = {}): EditRow {
  return {
    ts,
    wiki: 'en.wikipedia.org',
    lang: 'en',
    project: 'wikipedia',
    type: 'edit',
    title: 'Page',
    user: 'alice',
    is_bot: false,
    is_anon: false,
    is_minor: false,
    namespace: 0,
    delta: 10,
    new_len: 1000,
    comment: '',
    uri: '',
    ...overrides,
  };
}

/** Deterministic PRNG so nothing flakes. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let store: EventStore;

/** 1000 rows over the last 500 seconds, deterministic. */
function populated(): EventStore {
  const s = new EventStore();
  const random = rng(1234);
  const base = Date.now() / 1000;
  const rows: EditRow[] = [];
  for (let i = 0; i < 1000; i += 1) {
    rows.push(makeRow(base - 500 + i * 0.5, {
      lang: LANGS[i % LANGS.length]!,
      title: `Page${i % 50}`,
      user: `user${i % 25}`,
      is_bot: i % 4 === 0,
      is_anon: i % 7 === 0,
      namespace: i % 3 ? 0 : 14,
      delta: Math.floor(random() * 1000) - 500,
      comment: i % 11 === 0 ? 'reverted vandalism' : 'copyedit',
    }));
  }
  s.appendMany(rows);
  return s;
}

beforeEach(() => {
  store = populated();
});

// -- lexer ------------------------------------------------------------------

describe('lexer', () => {
  it('tokenizes a basic query', () => {
    const kinds = tokenize('SELECT lang FROM edits').map((t) => t.type);
    expect(kinds.slice(0, 4)).toEqual(['keyword', 'ident', 'keyword', 'ident']);
  });

  it.each([['30s', 30], ['5m', 300], ['2h', 7200], ['1d', 86400]])(
    'parses duration %s',
    (text, seconds) => {
      expect(parse(`SELECT count(*) FROM edits WINDOW ${text}`).windowSeconds).toBe(seconds);
    },
  );

  it('unescapes doubled quotes in strings', () => {
    expect(tokenize("SELECT 'it''s' FROM edits")[1]!.value).toBe("it's");
  });

  it('points at the opening quote of an unterminated string', () => {
    try {
      tokenize("SELECT 'oops FROM edits");
      expect.unreachable();
    } catch (err) {
      expect((err as SqlError).start).toBe(7);
    }
  });

  it('strips line comments', () => {
    expect(parse('SELECT lang -- a comment\nFROM edits').fromTable).toBe('edits');
  });

  it('does not treat an identifier starting with a unit letter as a duration', () => {
    const expr = parse('SELECT is_minor FROM edits').select[0]!.expr;
    expect(expr.kind === 'column' && expr.name).toBe('is_minor');
  });
});

// -- parser -----------------------------------------------------------------

describe('parser', () => {
  it('binds AND tighter than OR', () => {
    const where = parse('SELECT * FROM edits WHERE is_bot OR is_anon AND is_minor').where!;
    expect(where.kind === 'binary' && where.op).toBe('or');
    expect(where.kind === 'binary' && where.right.kind === 'binary' && where.right.op).toBe('and');
  });

  it('binds * tighter than +', () => {
    const expr = parse('SELECT delta + 2 * 3 AS x FROM edits').select[0]!.expr;
    expect(expr.kind === 'binary' && expr.op).toBe('+');
    expect(expr.kind === 'binary' && expr.right.kind === 'binary' && expr.right.op).toBe('*');
  });

  it('applies postfix to the operand, not the whole expression', () => {
    // Regression: `a LIKE 'x' AND b` must parse the AND rather than stopping.
    const where = parse("SELECT * FROM edits WHERE title LIKE '%x%' AND is_bot = true").where!;
    expect(where.kind === 'binary' && where.op).toBe('and');
  });

  it('parses NOT IN', () => {
    const where = parse('SELECT * FROM edits WHERE namespace NOT IN (0, 14)').where!;
    expect(where.kind === 'in' && where.negated).toBe(true);
    expect(where.kind === 'in' && where.values.length).toBe(2);
  });

  it('parses CASE', () => {
    const expr = parse("SELECT case when is_bot then 'b' else 'h' end AS who FROM edits")
      .select[0]!.expr;
    expect(expr.kind === 'case' && expr.whens.length).toBe(1);
  });

  it('accepts a bare alias', () => {
    expect(parse('SELECT count(*) edits FROM edits').select[0]!.alias).toBe('edits');
  });

  it('turns count(distinct x) into its own aggregate', () => {
    const expr = parse('SELECT count(distinct user) FROM edits').select[0]!.expr;
    expect(expr.kind === 'agg' && expr.name).toBe('count_distinct');
  });

  it('suggests alternatives for an unknown function', () => {
    try {
      parse('SELECT frobnicate(lang) FROM edits');
      expect.unreachable();
    } catch (err) {
      expect((err as SqlError).hint).toContain('Available functions');
    }
  });

  it('reports a span for a bad WINDOW', () => {
    try {
      parse('SELECT * FROM edits WINDOW 5');
      expect.unreachable();
    } catch (err) {
      const e = err as SqlError;
      expect(e.end).toBeGreaterThan(e.start);
      expect(e.hint).toContain('WINDOW 5m');
    }
  });

  it('rejects trailing statements', () => {
    expect(() => parse('SELECT * FROM edits; DROP TABLE edits')).toThrow(SqlError);
  });

  it('hints on an empty query', () => {
    try {
      parse('   ');
      expect.unreachable();
    } catch (err) {
      expect((err as SqlError).hint).toContain('SELECT');
    }
  });
});

// -- planner validation -----------------------------------------------------

describe('planner validation', () => {
  it('suggests the nearest column name', () => {
    try {
      runQuery('SELECT langg FROM edits', store);
      expect.unreachable();
    } catch (err) {
      expect((err as SqlError).hint).toContain('lang');
    }
  });

  it('rejects a bare column in a grouped select', () => {
    expect(() => runQuery('SELECT title, count(*) FROM edits GROUP BY lang', store))
      .toThrow(/must appear in GROUP BY/);
  });

  it('allows columns inside an expression grouped by its alias', () => {
    // Regression: GROUP BY an alias for a CASE over is_bot.
    const result = runQuery(
      "SELECT case when is_bot then 'bot' else 'human' end AS who, count(*) AS n " +
      'FROM edits GROUP BY who ORDER BY n DESC',
      store,
    );
    expect(new Set(result.rows.map((r) => r[0]))).toEqual(new Set(['bot', 'human']));
    expect(result.rows.reduce((sum, r) => sum + (r[1] as number), 0)).toBe(1000);
  });

  it('rejects aggregates in WHERE', () => {
    expect(() => runQuery('SELECT count(*) FROM edits WHERE count(*) > 1', store)).toThrow(SqlError);
  });

  it('rejects nested aggregates', () => {
    expect(() => runQuery('SELECT sum(count(delta)) FROM edits', store)).toThrow(SqlError);
  });

  it('rejects a window longer than the buffer', () => {
    expect(() => runQuery('SELECT count(*) FROM edits WINDOW 1d', store)).toThrow(/buffer/);
  });

  it('rejects an unknown table', () => {
    expect(() => runQuery('SELECT count(*) FROM pages', store)).toThrow(SqlError);
  });

  it('rejects a non-constant LIKE pattern', () => {
    expect(() => runQuery('SELECT count(*) FROM edits WHERE title LIKE comment', store))
      .toThrow(/constant string pattern/);
  });
});

// -- execution --------------------------------------------------------------

describe('execution', () => {
  it('counts every row', () => {
    expect(runQuery('SELECT count(*) AS n FROM edits', store).rows).toEqual([[1000]]);
  });

  it('partitions rows with WHERE', () => {
    const bots = runQuery('SELECT count(*) AS n FROM edits WHERE is_bot', store).rows[0]![0];
    const humans = runQuery('SELECT count(*) AS n FROM edits WHERE NOT is_bot', store).rows[0]![0];
    expect(bots).toBe(250);
    expect((bots as number) + (humans as number)).toBe(1000);
  });

  it('partitions rows with GROUP BY', () => {
    const result = runQuery(
      'SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY n DESC', store,
    );
    expect(result.rows.length).toBe(5);
    expect(result.rows.reduce((sum, r) => sum + (r[1] as number), 0)).toBe(1000);
  });

  it('groups by multiple keys without collisions', () => {
    const result = runQuery(
      'SELECT lang, namespace, count(*) AS n FROM edits GROUP BY lang, namespace', store,
    );
    expect(result.rows.reduce((sum, r) => sum + (r[2] as number), 0)).toBe(1000);
    expect(result.keyColumns).toBe(2);
  });

  it('does not merge distinct key tuples that concatenate alike', () => {
    // Regression: joining key parts without a separator made ('a','bc') and
    // ('ab','c') the same group.
    const s = new EventStore();
    const base = Date.now() / 1000;
    s.appendMany([
      makeRow(base, { lang: 'a', title: 'bc' }),
      makeRow(base, { lang: 'ab', title: 'c' }),
    ]);
    const result = runQuery('SELECT lang, title, count(*) AS n FROM edits GROUP BY lang, title', s);
    expect(result.rows.length).toBe(2);
  });

  it('orders descending and truncates at LIMIT', () => {
    const result = runQuery(
      'SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY n DESC LIMIT 2', store,
    );
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]![1] as number).toBeGreaterThanOrEqual(result.rows[1]![1] as number);
    expect(result.truncated).toBe(true);
  });

  it('keeps sum, avg, and count consistent', () => {
    const [sum, avg, n] = runQuery(
      'SELECT sum(delta) AS s, avg(delta) AS a, count(*) AS n FROM edits', store,
    ).rows[0]! as number[];
    expect(Math.abs((sum as number) / (n as number) - (avg as number))).toBeLessThan(0.01);
  });

  it('orders min below max', () => {
    const [lo, hi] = runQuery('SELECT min(delta) AS lo, max(delta) AS hi FROM edits', store)
      .rows[0]! as number[];
    expect(lo).toBeLessThanOrEqual(hi!);
  });

  it('estimates distinct counts', () => {
    const users = runQuery('SELECT count(distinct user) AS u FROM edits', store).rows[0]![0];
    expect(Math.abs((users as number) - 25)).toBeLessThanOrEqual(1);
  });

  it('orders percentiles', () => {
    const [p10, p50, p90] = runQuery(
      'SELECT percentile(delta, 10) AS p10, percentile(delta, 50) AS p50, ' +
      'percentile(delta, 90) AS p90 FROM edits', store,
    ).rows[0]! as number[];
    expect(p10).toBeLessThanOrEqual(p50!);
    expect(p50).toBeLessThanOrEqual(p90!);
  });

  it('returns top_k as pairs', () => {
    const top = runQuery('SELECT top_k(lang, 3) AS langs FROM edits', store).rows[0]![0];
    expect(Array.isArray(top)).toBe(true);
    expect((top as Array<[string, number]>).length).toBe(3);
  });

  it('matches LIKE patterns case-insensitively', () => {
    const contains = runQuery(
      "SELECT count(*) AS n FROM edits WHERE comment LIKE '%vandal%'", store,
    ).rows[0]![0] as number;
    const prefix = runQuery(
      "SELECT count(*) AS n FROM edits WHERE comment LIKE 'reverted%'", store,
    ).rows[0]![0] as number;
    const upper = runQuery(
      "SELECT count(*) AS n FROM edits WHERE comment LIKE '%VANDAL%'", store,
    ).rows[0]![0] as number;
    expect(contains).toBe(prefix);
    expect(contains).toBe(upper);
    expect(contains).toBeGreaterThan(0);
  });

  it('filters with IN', () => {
    expect(runQuery("SELECT count(*) AS n FROM edits WHERE lang IN ('en', 'de')", store)
      .rows[0]![0]).toBe(400);
  });

  it('returns scalar rows newest first', () => {
    const timestamps = runQuery('SELECT ts FROM edits LIMIT 5', store).rows.map((r) => r[0] as number);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('expands * to every column', () => {
    expect(runQuery('SELECT * FROM edits LIMIT 1', store).columns.length).toBe(15);
  });

  it('notes the default limit', () => {
    const result = runQuery('SELECT title FROM edits', store);
    expect(result.rows.length).toBe(200);
    expect(result.notes.some((note) => note.includes('LIMIT'))).toBe(true);
  });

  it('returns zero for an aggregate over an empty store', () => {
    expect(runQuery('SELECT count(*) AS n FROM edits', new EventStore()).rows).toEqual([[0]]);
  });

  it('returns no rows for a grouped query over an empty store', () => {
    expect(runQuery('SELECT lang, count(*) FROM edits GROUP BY lang', new EventStore()).rows)
      .toEqual([]);
  });

  it('restricts rows to the window', () => {
    const s = new EventStore();
    const base = Date.now() / 1000;
    s.appendMany([makeRow(base - 400), makeRow(base - 10), makeRow(base - 5)]);
    expect(runQuery('SELECT count(*) AS n FROM edits WINDOW 60s', s).rows[0]![0]).toBe(2);
    expect(runQuery('SELECT count(*) AS n FROM edits', s).rows[0]![0]).toBe(3);
  });

  it('yields zero rather than Infinity on division by zero', () => {
    expect(runQuery('SELECT count(*) / 0 AS x FROM edits', store).rows[0]![0]).toBe(0);
  });

  it('errors when comparing a string column to a number', () => {
    expect(() => runQuery('SELECT count(*) FROM edits WHERE lang > 5', store)).toThrow(/compare/i);
  });

  it('sorts mixed types without crashing', () => {
    const result = runQuery(
      "SELECT case when is_bot then 1 else 'none' end AS mixed, count(*) AS n " +
      'FROM edits GROUP BY mixed ORDER BY mixed', store,
    );
    expect(result.rows.length).toBe(2);
  });

  it('reports scanned and matched counts', () => {
    const result = runQuery('SELECT count(*) AS n FROM edits WHERE is_bot', store);
    expect(result.scanned).toBe(1000);
    expect(result.matched).toBe(250);
  });
});

// -- optimizer --------------------------------------------------------------

describe('optimizer', () => {
  it('computes an identical aggregate once', () => {
    const scan = store.snapshot(null);
    const compiled = plan(
      parse('SELECT lang, count(*) AS n FROM edits GROUP BY lang ORDER BY count(*) DESC'),
      scan.columns,
      Date.now() / 1000,
    );
    expect(compiled.aggs.length).toBe(1);
  });

  it('orders WHERE conjuncts cheapest first', () => {
    const where = parse("SELECT * FROM edits WHERE comment LIKE '%x%' AND is_bot = true").where!;
    const costs = splitConjuncts(reorderWhere(where)).map(cost);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it('folds constant subtrees', () => {
    const folded = fold(parse('SELECT * FROM edits WHERE delta > 2 * 50').where!);
    expect(folded.kind === 'binary' && folded.right.kind === 'literal' && folded.right.value)
      .toBe(100);
  });
});
