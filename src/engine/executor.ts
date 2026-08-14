import { SqlError } from './lexer';
import { type Plan, plan } from './planner';
import { parse } from './parser';
import { HyperLogLog, TDigest } from './sketches';
import type { EventStore, Scan } from './store';

/**
 * Executes a compiled Plan against a columnar Scan.
 *
 * Execution re-scans the window each tick rather than maintaining incremental
 * aggregate state. That is a deliberate trade: incremental aggregation is where
 * streaming engines accumulate their subtlest bugs (retraction on window expiry,
 * out-of-order arrivals, non-invertible aggregates like min/max that cannot be
 * undone). A full scan of a bounded window is trivially correct and costs tens
 * of milliseconds at this size. Incrementality is applied where it is safe and
 * where it actually matters instead: in the result deltas sent to the UI.
 */

/** Guards a pathological GROUP BY (e.g. by title over a full window). */
const MAX_GROUPS = 200_000;

/** Rows returned when a non-aggregate query omits LIMIT. */
export const DEFAULT_ROW_LIMIT = 200;

export type ResultValue = string | number | boolean | null | Array<[string, number]>;
export type ResultRow = ResultValue[];

export interface QueryResult {
  columns: string[];
  rows: ResultRow[];
  /** Rows examined after windowing; surfaced in the UI so cost is visible. */
  scanned: number;
  matched: number;
  elapsedMs: number;
  truncated: boolean;
  windowSeconds: number | null;
  notes: string[];
  /** Leading projections that are grouping keys, for stable row identity. */
  keyColumns: number;
}

/** Per-group accumulator for one aggregate. */
class Acc {
  private n = 0;
  private total = 0;
  private best: unknown = null;
  private hll: HyperLogLog | null;
  private digest: TDigest | null;
  private counts: Map<string, number> | null;

  constructor(private readonly name: string, private readonly extra: number | null) {
    this.hll = name === 'count_distinct' ? new HyperLogLog(12) : null;
    this.digest = name === 'percentile' ? new TDigest() : null;
    this.counts = name === 'top_k' ? new Map() : null;
  }

  update(value: unknown): void {
    switch (this.name) {
      case 'count':
        this.n += 1;
        return;
      case 'count_distinct':
        if (value !== null && value !== undefined) this.hll!.add(String(value));
        return;
      case 'percentile':
        if (value !== null && value !== undefined) this.digest!.add(Number(value));
        return;
      case 'top_k': {
        if (value === null || value === undefined) return;
        const key = String(value);
        this.counts!.set(key, (this.counts!.get(key) ?? 0) + 1);
        return;
      }
      case 'sum':
      case 'avg':
        if (value !== null && value !== undefined) {
          this.total += Number(value);
          this.n += 1;
        }
        return;
      case 'min':
        if (value !== null && value !== undefined) {
          if (this.best === null || (value as number) < (this.best as number)) this.best = value;
        }
        return;
      case 'max':
        if (value !== null && value !== undefined) {
          if (this.best === null || (value as number) > (this.best as number)) this.best = value;
        }
        return;
      default:
        return;
    }
  }

  finish(): ResultValue {
    switch (this.name) {
      case 'count':
        return this.n;
      case 'sum':
        return Number.isInteger(this.total) ? this.total : Number(this.total.toFixed(6));
      case 'avg':
        return this.n ? Number((this.total / this.n).toFixed(3)) : 0;
      case 'min':
      case 'max':
        return (this.best ?? null) as ResultValue;
      case 'count_distinct':
        return this.hll!.count();
      case 'percentile':
        return Number(this.digest!.quantile(this.extra ?? 0.5).toFixed(2));
      case 'top_k':
        return [...this.counts!.entries()]
          .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
          .slice(0, this.extra ?? 10);
      default:
        return null;
    }
  }
}

/**
 * Total order across mixed types, since a column can produce both.
 *
 * JavaScript will happily compare a string with a number and return nonsense; a
 * live query must not reorder unpredictably because one group key happened to
 * be empty. Sorting by (type rank, value) keeps ordering stable and predictable.
 */
function sortKey(value: unknown): [number, string | number] {
  if (value === null || value === undefined) return [0, 0];
  if (typeof value === 'boolean') return [1, value ? 1 : 0];
  if (typeof value === 'number') return [2, value];
  if (typeof value === 'string') return [3, value];
  return [4, String(value)];
}

function compareValues(a: unknown, b: unknown): number {
  const [ra, va] = sortKey(a);
  const [rb, vb] = sortKey(b);
  if (ra !== rb) return ra - rb;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
}

export function execute(compiled: Plan, scan: Scan): QueryResult {
  const started = performance.now();
  const n = scan.length;
  const notes: string[] = [];

  let matching: number[];
  if (compiled.where === null) {
    matching = new Array(n);
    for (let i = 0; i < n; i += 1) matching[i] = i;
  } else {
    matching = [];
    for (let i = 0; i < n; i += 1) if (compiled.where(i)) matching.push(i);
  }
  const matched = matching.length;

  const { rows, truncated } = compiled.isAggregate
    ? runAggregate(compiled, matching, notes)
    : runScalar(compiled, matching, notes);

  const projectionNames = compiled.projections.map((p) => p.name);

  // Count the leading projections that are exactly grouping keys. Only a
  // contiguous run from the front counts, since the UI keys rows on a prefix.
  let keyColumns = 0;
  if (compiled.isAggregate) {
    const keyNames = new Set(compiled.groupKeys.map((k) => k.name));
    for (const name of projectionNames) {
      if (keyNames.has(name)) keyColumns += 1;
      else break;
    }
  }

  return {
    columns: projectionNames,
    rows,
    scanned: n,
    matched,
    elapsedMs: performance.now() - started,
    truncated,
    windowSeconds: compiled.windowSeconds,
    notes,
    keyColumns,
  };
}

function runAggregate(
  compiled: Plan,
  matching: number[],
  notes: string[],
): { rows: ResultRow[]; truncated: boolean } {
  const keyFns = compiled.groupKeys.map((k) => k.fn);
  const specs = compiled.aggs;

  const groups = new Map<string, { index: number; accs: Acc[] }>();
  let overflowed = false;

  for (const i of matching) {
    // Unit separator between key parts: a character that cannot appear in a
    // wiki title or username, so distinct key tuples cannot collide.
    const key = keyFns.length ? keyFns.map((fn) => String(fn(i))).join('\u001f') : '';
    let entry = groups.get(key);
    if (entry === undefined) {
      if (groups.size >= MAX_GROUPS) {
        overflowed = true;
        continue;
      }
      entry = { index: i, accs: specs.map((s) => new Acc(s.name, s.extra)) };
      groups.set(key, entry);
    }
    for (let s = 0; s < specs.length; s += 1) {
      const spec = specs[s]!;
      entry.accs[s]!.update(spec.arg ? spec.arg(i) : null);
    }
  }

  if (overflowed) {
    notes.push(
      `Group cardinality exceeded ${MAX_GROUPS.toLocaleString()}; extra groups were dropped. ` +
      'Add a WHERE filter or group by a lower-cardinality column.',
    );
  }

  // An aggregate with no GROUP BY over zero rows still returns one row, which
  // is what makes `SELECT count(*) FROM edits` show 0 rather than nothing.
  if (groups.size === 0 && keyFns.length === 0) {
    groups.set('', { index: 0, accs: specs.map((s) => new Acc(s.name, s.extra)) });
  }

  // Finish each group's accumulators exactly once: top_k sorts its candidate
  // map and percentile flushes its digest, so finishing twice is real work.
  let finished = [...groups.values()].map(({ index, accs }) => ({
    index,
    values: accs.map((acc) => acc.finish()) as unknown[],
  }));

  if (compiled.orderBy.length > 0) {
    const keyed = finished.map((entry) => ({
      keys: compiled.orderBy.map((o) => o.fn(entry.index, entry.values)),
      entry,
    }));
    // Sort by each key in reverse order, relying on a stable sort to produce
    // correct multi-key ordering.
    for (let pos = compiled.orderBy.length - 1; pos >= 0; pos -= 1) {
      const descending = compiled.orderBy[pos]!.descending;
      keyed.sort((a, b) => {
        const cmp = compareValues(a.keys[pos], b.keys[pos]);
        return descending ? -cmp : cmp;
      });
    }
    finished = keyed.map((k) => k.entry);
  }

  let truncated = false;
  if (compiled.limit !== null && finished.length > compiled.limit) {
    finished = finished.slice(0, compiled.limit);
    truncated = true;
  }

  const rows = finished.map(({ index, values }) =>
    compiled.projections.map((p) => p.fn(index, values) as ResultValue),
  );

  return { rows, truncated };
}

function runScalar(
  compiled: Plan,
  matching: number[],
  notes: string[],
): { rows: ResultRow[]; truncated: boolean } {
  const limit = compiled.limit ?? DEFAULT_ROW_LIMIT;
  if (compiled.limit === null) {
    notes.push(`No LIMIT given; showing the ${DEFAULT_ROW_LIMIT} most recent matches.`);
  }

  let indexes = matching;

  if (compiled.orderBy.length > 0) {
    indexes = [...matching];
    for (let pos = compiled.orderBy.length - 1; pos >= 0; pos -= 1) {
      const { fn, descending } = compiled.orderBy[pos]!;
      indexes.sort((a, b) => {
        const cmp = compareValues(fn(a, []), fn(b, []));
        return descending ? -cmp : cmp;
      });
    }
  } else {
    // Newest first: the stream's natural order is oldest-first, and a live feed
    // that scrolls the wrong way feels broken.
    indexes = [...matching].reverse();
  }

  const truncated = indexes.length > limit;
  const rows = indexes
    .slice(0, limit)
    .map((i) => compiled.projections.map((p) => p.fn(i, []) as ResultValue));

  return { rows, truncated };
}

/** Parse, plan, and execute `sql` against the live store. */
export function runQuery(
  sql: string,
  store: EventStore,
  defaultWindow: number | null = null,
): QueryResult {
  const query = parse(sql);

  const windowSeconds = query.windowSeconds ?? defaultWindow;
  if (windowSeconds !== null && windowSeconds > store.windowSeconds) {
    const minutes = Math.round(store.windowSeconds / 60);
    throw new SqlError(
      `WINDOW exceeds the ${minutes}-minute buffer this page holds.`,
      0,
      sql.length,
      `Try WINDOW ${minutes}m or less. The buffer grows the longer this tab stays open.`,
    );
  }

  const scan = store.snapshot(windowSeconds);
  const compiled = plan(query, scan.columns, Date.now() / 1000);
  const result = execute(compiled, scan);
  result.windowSeconds = windowSeconds;
  return result;
}
