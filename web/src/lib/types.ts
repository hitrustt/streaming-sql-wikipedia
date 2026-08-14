export type Scalar = string | number | boolean | null | Array<[string, number]>;
export type Row = Scalar[];

export interface Column {
  name: string;
  type: 'int' | 'float' | 'string' | 'bool' | 'timestamp';
  doc: string;
  facetable: boolean;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  sql: string;
  viz: 'bar' | 'table' | 'stat' | 'line';
}

export interface QueryMeta {
  columns: string[];
  scanned: number;
  matched: number;
  elapsed_ms: number;
  truncated: boolean;
  window_seconds: number | null;
  notes: string[];
  key_columns: number;
}

export interface SqlErrorInfo {
  message: string;
  start: number;
  end: number;
  hint: string | null;
}

export interface StoreStats {
  buffered_rows: number;
  total_ingested: number;
  events_per_second: number;
  window_seconds: number;
  rollup_minutes: number;
  uptime_seconds: number;
  last_event_age: number | null;
}

export interface IngestStats {
  connected: boolean;
  events_received: number;
  events_kept: number;
  parse_errors: number;
  reconnects: number;
  last_error: string | null;
  uptime_seconds: number;
  last_event_age: number | null;
  median_lag_seconds: number | null;
}

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

export interface Delta {
  op: 'set' | 'remove';
  key: string;
  index: number;
  row?: Row;
}

export type ServerMessage =
  | { type: 'welcome'; presets: Preset[]; columns: Column[]; stats: StoreStats; ingest: IngestStats }
  | {
      type: 'result';
      id: string;
      full: boolean;
      columns: string[];
      rows?: Row[];
      keys?: string[] | null;
      deltas?: Delta[];
      meta: QueryMeta;
    }
  | { type: 'query_error'; id: string; error: SqlErrorInfo }
  | {
      type: 'feed';
      events: EditEvent[];
      stats: StoreStats;
      ingest: IngestStats;
      headline: QueryMeta & { rows: Row[] };
    }
  | { type: 'error'; message: string }
  | { type: 'pong'; t: number };

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
