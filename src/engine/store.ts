import { COLUMNS, type CellValue, type EditRow, zeroFor } from './schema';
import { CountMinSketch, HyperLogLog, TDigest } from './sketches';

/**
 * In-memory columnar ring buffer, plus sketch-backed rollups.
 *
 * Why not IndexedDB or a WASM database: every query here is a full scan over a
 * bounded, recent time range with no point lookups and no joins. A database
 * would add serialization, its own query planner fighting ours, and async I/O
 * to a workload that fits comfortably in a tab's memory.
 *
 * Why columnar: a typical query touches two or three of fifteen columns. Column
 * arrays mean those scans walk contiguous memory instead of chasing pointers
 * through per-row objects, and a JS engine can keep a monomorphic array of
 * numbers unboxed, which it cannot do for object properties.
 */

/**
 * Raw retention. Shorter than the server version's 30 minutes: this runs in a
 * visitor's tab alongside everything else they have open, and 15 minutes at the
 * real firehose rate is already ~20k rows.
 */
export const DEFAULT_WINDOW_SECONDS = 15 * 60;

/**
 * Hard row cap, so a traffic spike or a long-lived tab cannot exhaust memory.
 * Whichever bound is hit first wins.
 */
export const DEFAULT_MAX_ROWS = 80_000;

export interface RollupBucket {
  minute: number;
  events: number;
  botEvents: number;
  anonEvents: number;
  bytesAdded: number;
  bytesRemoved: number;
  users: HyperLogLog;
  titles: CountMinSketch;
  deltas: TDigest;
}

export interface RollupSummary {
  minute: number;
  events: number;
  botEvents: number;
  anonEvents: number;
  bytesAdded: number;
  bytesRemoved: number;
  distinctUsers: number;
  p50Delta: number;
  p99Delta: number;
}

export interface StoreStats {
  bufferedRows: number;
  totalIngested: number;
  eventsPerSecond: number;
  windowSeconds: number;
  oldestAge: number | null;
  lastEventAge: number | null;
  uptimeSeconds: number;
}

/** An immutable columnar slice handed to the executor. */
export interface Scan {
  columns: Record<string, CellValue[]>;
  length: number;
}

const now = () => Date.now() / 1000;

export class EventStore {
  readonly windowSeconds: number;
  readonly maxRows: number;
  readonly columns: Record<string, CellValue[]> = {};

  private readonly rollupMinutes: number;
  private readonly rollups = new Map<number, RollupBucket>();
  private readonly startedAt = now();

  /** Oldest retained row id, so callers can tell rows were dropped. */
  baseOffset = 0;
  totalIngested = 0;
  lastEventAt: number | null = null;

  constructor(
    windowSeconds = DEFAULT_WINDOW_SECONDS,
    maxRows = DEFAULT_MAX_ROWS,
    rollupMinutes = 180,
  ) {
    this.windowSeconds = windowSeconds;
    this.maxRows = maxRows;
    this.rollupMinutes = rollupMinutes;
    for (const column of COLUMNS) this.columns[column.name] = [];
  }

  appendMany(rows: EditRow[]): number {
    if (rows.length === 0) return 0;

    for (const row of rows) {
      for (const column of COLUMNS) {
        const value = row[column.name];
        this.columns[column.name]!.push(value === undefined ? zeroFor(column.type) : value);
      }
      this.updateRollup(row);
    }

    this.totalIngested += rows.length;
    this.lastEventAt = now();
    this.evict();
    return rows.length;
  }

  append(row: EditRow): void {
    this.appendMany([row]);
  }

  private updateRollup(row: EditRow): void {
    const minute = Math.floor(Number(row.ts ?? now()) / 60);
    let bucket = this.rollups.get(minute);
    if (bucket === undefined) {
      bucket = {
        minute,
        events: 0,
        botEvents: 0,
        anonEvents: 0,
        bytesAdded: 0,
        bytesRemoved: 0,
        users: new HyperLogLog(11),
        titles: new CountMinSketch(1024, 4, 40),
        deltas: new TDigest(),
      };
      this.rollups.set(minute, bucket);
    }

    bucket.events += 1;
    if (row.is_bot) bucket.botEvents += 1;
    if (row.is_anon) bucket.anonEvents += 1;

    const delta = Number(row.delta ?? 0);
    if (delta > 0) bucket.bytesAdded += delta;
    else bucket.bytesRemoved += -delta;
    bucket.deltas.add(delta);

    if (row.user) bucket.users.add(String(row.user));
    if (row.title) bucket.titles.add(String(row.title));

    if (this.rollups.size > this.rollupMinutes) {
      const stale = [...this.rollups.keys()].sort((a, b) => a - b);
      for (let i = 0; i < stale.length - this.rollupMinutes; i += 1) {
        this.rollups.delete(stale[i]!);
      }
    }
  }

  /**
   * Drop rows past the retention window or the row cap.
   *
   * Eviction is a single splice per column rather than repeated shifts: shifting
   * from the front of an array is O(n) *per row* and would dominate the ingest
   * path, while one splice is a single bulk move.
   */
  private evict(): void {
    const ts = this.columns.ts!;
    const n = ts.length;
    if (n === 0) return;

    const cutoff = now() - this.windowSeconds;

    // Rows arrive in near-timestamp order, so scanning from the front costs
    // O(evicted) rather than O(n).
    let drop = 0;
    while (drop < n && Number(ts[drop]) < cutoff) drop += 1;

    if (n - drop > this.maxRows) drop = n - this.maxRows;

    if (drop > 0) {
      for (const column of COLUMNS) this.columns[column.name]!.splice(0, drop);
      this.baseOffset += drop;
    }
  }

  /**
   * An immutable view of the rows inside `windowSeconds`.
   *
   * Unlike the server version this does not copy: the worker is single-threaded
   * and nothing mutates the store while a query runs, so slicing would be pure
   * waste. A start offset is carried instead, and the executor indexes from it.
   */
  snapshot(windowSeconds: number | null): Scan {
    const ts = this.columns.ts!;
    const n = ts.length;
    if (n === 0) {
      const empty: Record<string, CellValue[]> = {};
      for (const column of COLUMNS) empty[column.name] = [];
      return { columns: empty, length: 0 };
    }

    let start = 0;
    if (windowSeconds !== null) {
      const cutoff = now() - windowSeconds;
      // Binary search: timestamps are effectively sorted.
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(ts[mid]) < cutoff) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }

    if (start === 0) return { columns: this.columns, length: n };

    const sliced: Record<string, CellValue[]> = {};
    for (const column of COLUMNS) sliced[column.name] = this.columns[column.name]!.slice(start);
    return { columns: sliced, length: n - start };
  }

  /**
   * Most recent rows, newest first, for the live feed.
   *
   * `humanOnly` restricts to people editing real Wikipedia articles. The filter
   * belongs here rather than in the UI: bots are ~58% of the stream and most of
   * the rest is Wikidata, so filtering a dozen already-selected rows would
   * usually leave one or two. The scan walks backwards and stops as soon as it
   * has enough, so it costs what it returns, not the buffer size.
   */
  recent(limit = 20, humanOnly = false): EditRow[] {
    const n = this.columns.ts!.length;
    const rows: EditRow[] = [];

    for (let i = n - 1; i >= 0 && rows.length < limit; i -= 1) {
      if (humanOnly) {
        if (this.columns.is_bot![i]) continue;
        if (this.columns.project![i] !== 'wikipedia') continue;
        if (this.columns.namespace![i] !== 0) continue;
      }
      const row: EditRow = {};
      for (const column of COLUMNS) row[column.name] = this.columns[column.name]![i]!;
      rows.push(row);
    }

    return rows;
  }

  stats(): StoreStats {
    const ts = this.columns.ts!;
    const n = ts.length;
    const current = now();

    // Rate over the last minute of *event time*, divided by the span of event
    // time actually covered.
    //
    // Dividing by wall-clock elapsed instead would be wrong in both directions:
    // it under-reports by up to 60x during the first minute (less than a minute
    // of data, flat 60s divisor), and it wildly over-reports during the startup
    // backfill, where 90 seconds of history arrives in about two seconds.
    // Measuring event time against event time is immune to both.
    const recentCut = current - 60;
    let recentCount = 0;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (Number(ts[i]) < recentCut) break;
      recentCount += 1;
    }
    const oldestRetained = n > 0 ? Number(ts[0]) : current;
    const covered = current - Math.max(oldestRetained, recentCut);
    const elapsed = Math.max(1, Math.min(60, covered));

    return {
      bufferedRows: n,
      totalIngested: this.totalIngested,
      eventsPerSecond: Number((recentCount / elapsed).toFixed(2)),
      windowSeconds: this.windowSeconds,
      oldestAge: n > 0 ? Number((current - Number(ts[0])).toFixed(1)) : null,
      lastEventAge: this.lastEventAt ? Number((current - this.lastEventAt).toFixed(2)) : null,
      uptimeSeconds: Number((current - this.startedAt).toFixed(1)),
    };
  }

  rollupSeries(minutes = 180): RollupSummary[] {
    const keys = [...this.rollups.keys()].sort((a, b) => a - b).slice(-minutes);
    return keys.map((key) => {
      const bucket = this.rollups.get(key)!;
      return {
        minute: bucket.minute,
        events: bucket.events,
        botEvents: bucket.botEvents,
        anonEvents: bucket.anonEvents,
        bytesAdded: bucket.bytesAdded,
        bytesRemoved: bucket.bytesRemoved,
        distinctUsers: bucket.users.count(),
        p50Delta: Number(bucket.deltas.quantile(0.5).toFixed(1)),
        p99Delta: Number(bucket.deltas.quantile(0.99).toFixed(1)),
      };
    });
  }
}
