import { type QueryResult, type ResultRow, runQuery } from './executor';
import { SqlError } from './lexer';
import type { EventStore } from './store';

/**
 * Continuous queries and result-delta computation.
 *
 * A subscription is a SQL string plus the last result sent to the UI. Each tick
 * the query is re-run and diffed against the previous result; only changed rows
 * cross the worker boundary.
 *
 * This matters more than it looks. Every message between a worker and the main
 * thread is structured-cloned, which costs real time proportional to payload
 * size. A top-15 table at one tick per second is a few KB of cloning per tick,
 * but usually only one or two rows actually changed. Sending diffs keeps the
 * main thread free and -- more visibly -- lets the UI animate exactly the cells
 * that changed rather than repainting the table.
 */

export const DEFAULT_TICK_MS = 1000;

/** A query slower than this gets its tick stretched, so it cannot hog the worker. */
const SLOW_QUERY_MS = 250;

export interface RowDelta {
  op: 'set' | 'remove';
  key: string;
  index: number;
  row?: ResultRow;
}

export interface ResultMessage {
  type: 'result';
  id: string;
  full: boolean;
  columns: string[];
  rows?: ResultRow[];
  keys?: string[] | null;
  deltas?: RowDelta[];
  meta: Omit<QueryResult, 'rows'> & { rows: never[] };
}

export interface QueryErrorMessage {
  type: 'queryError';
  id: string;
  error: { message: string; start: number; end: number; hint: string | null };
}

/**
 * Identity for a result row across ticks.
 *
 * For an aggregate query the grouping keys are stable tick to tick, which lets
 * the UI animate a row climbing the rankings instead of seeing it vanish and
 * reappear. All key columns are used: keying `GROUP BY title, lang` on the title
 * alone would merge the English and German articles of the same name into one
 * flickering row.
 *
 * Scalar queries have no such identity, so rows fall back to position.
 */
/** Unit separator: cannot occur in a wiki title or username, so keys cannot collide. */
const SEP = String.fromCharCode(31);

function rowKey(row: ResultRow, index: number, keyColumns: number): string {
  if (row.length === 0 || keyColumns <= 0) return `#${index}`;
  return `k:${row.slice(0, keyColumns).map((v) => String(v)).join(SEP)}`;
}

export class Subscription {
  private columns: string[] = [];
  private lastRows = new Map<string, ResultRow>();
  private lastOrder: string[] = [];
  private nextRun = 0;

  tickMs = DEFAULT_TICK_MS;

  constructor(readonly id: string, public sql: string) {}

  due(nowMs: number): boolean {
    return nowMs >= this.nextRun;
  }

  /** Run the query and return a message describing what changed. */
  evaluate(store: EventStore): ResultMessage | QueryErrorMessage {
    let result: QueryResult;
    try {
      result = runQuery(this.sql, store);
    } catch (err) {
      // Back off while the query is broken, so a typo does not spin the worker.
      this.nextRun = Date.now() + 2000;
      const error = err instanceof SqlError
        ? { message: err.message, start: err.start, end: err.end, hint: err.hint }
        : { message: `Query failed: ${String(err)}`, start: 0, end: 0, hint: null };
      return { type: 'queryError', id: this.id, error };
    }

    // Adaptive pacing: an expensive query runs less often rather than
    // monopolizing the worker.
    this.tickMs = result.elapsedMs < SLOW_QUERY_MS
      ? DEFAULT_TICK_MS
      : Math.min(5000, result.elapsedMs * 10);
    this.nextRun = Date.now() + this.tickMs;

    const meta = { ...result, rows: [] as never[] };

    // A changed column set means a different query shape; resend in full.
    if (
      result.columns.length !== this.columns.length ||
      result.columns.some((c, i) => c !== this.columns[i])
    ) {
      this.columns = [...result.columns];
      const keys = result.rows.map((row, i) => rowKey(row, i, result.keyColumns));
      this.lastRows = new Map(keys.map((key, i) => [key, result.rows[i]!]));
      this.lastOrder = keys;
      return {
        type: 'result',
        id: this.id,
        full: true,
        columns: result.columns,
        rows: result.rows,
        keys,
        meta,
      };
    }

    const keys = result.rows.map((row, i) => rowKey(row, i, result.keyColumns));
    const newRows = new Map(keys.map((key, i) => [key, result.rows[i]!]));

    const deltas: RowDelta[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const row = newRows.get(key)!;
      const previous = this.lastRows.get(key);
      if (previous === undefined || !sameRow(previous, row)) {
        deltas.push({ op: 'set', key, index, row });
      }
    }
    for (const key of this.lastRows.keys()) {
      if (!newRows.has(key)) deltas.push({ op: 'remove', key, index: 0 });
    }

    const orderChanged =
      keys.length !== this.lastOrder.length || keys.some((k, i) => k !== this.lastOrder[i]);

    this.lastRows = newRows;
    this.lastOrder = keys;

    return {
      type: 'result',
      id: this.id,
      full: false,
      columns: result.columns,
      deltas,
      // Null means the ordering did not change this tick, so the UI keeps its
      // current order and only repaints the changed cells.
      keys: orderChanged ? keys : null,
      meta,
    };
  }
}

function sameRow(a: ResultRow, b: ResultRow): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    // top_k returns a nested array; compare it structurally rather than by
    // reference, or every tick would look like a change.
    if (Array.isArray(x) && Array.isArray(y)) {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
      continue;
    }
    return false;
  }
  return true;
}
