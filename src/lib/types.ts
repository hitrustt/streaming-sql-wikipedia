import type { ResultRow } from '../engine/executor';
import type { RowDelta } from '../engine/subscriptions';

export type {
  Column, EditRow, IngestStats, Preset, ResultRow, StoreStats,
} from '../engine/protocol';
export type { ResultValue as Scalar } from '../engine/executor';

export type Row = ResultRow;

/**
 * A feed row with its columns typed.
 *
 * The engine stores rows as an open record because the schema is data, not
 * types. The feed is the one place the UI reads specific fields, so it gets a
 * concrete shape rather than indexing an untyped record everywhere.
 */
export interface EditEvent {
  ts: number;
  wiki: string;
  lang: string;
  project: string;
  type: string;
  title: string;
  user: string;
  is_bot: boolean;
  is_anon: boolean;
  is_minor: boolean;
  namespace: number;
  delta: number;
  new_len: number;
  comment: string;
  uri: string;
}

export interface SqlErrorInfo {
  message: string;
  start: number;
  end: number;
  hint: string | null;
}

/** Result metadata, minus the rows themselves. */
export interface QueryMeta {
  columns: string[];
  scanned: number;
  matched: number;
  elapsedMs: number;
  truncated: boolean;
  windowSeconds: number | null;
  notes: string[];
  keyColumns: number;
}

/** A live result set, maintained locally by applying deltas. */
export interface LiveResult {
  columns: string[];
  keys: string[];
  rows: Map<string, Row>;
  meta: QueryMeta | null;
  /** Row keys touched by the most recent delta, for the settle animation. */
  changed: Set<string>;
  error: SqlErrorInfo | null;
}

export const emptyResult = (): LiveResult => ({
  columns: [],
  keys: [],
  rows: new Map(),
  meta: null,
  changed: new Set(),
  error: null,
});

/** Materialize a live result back into ordered rows for rendering. */
export function orderedRows(result: LiveResult): Array<{ key: string; row: Row }> {
  const out: Array<{ key: string; row: Row }> = [];
  for (const key of result.keys) {
    const row = result.rows.get(key);
    if (row) out.push({ key, row });
  }
  return out;
}

export type { RowDelta };
