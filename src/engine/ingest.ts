import type { EditRow } from './schema';

/**
 * Wikimedia EventStreams client, running inside the worker.
 *
 * Connects to the public `recentchange` stream -- every edit to every Wikimedia
 * wiki, roughly 20-50 events per second -- and normalizes each event into the
 * flat `edits` row the query engine expects.
 *
 * The browser can talk to this endpoint directly because Wikimedia serves it
 * with `access-control-allow-origin: *`. That single header is why this project
 * needs no backend at all.
 */

export const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';

/**
 * How much history to replay on startup.
 *
 * The buffer is empty when the page loads, so without a backfill a visitor
 * stares at "no rows yet" for minutes. The stream's `since` parameter replays
 * from a timestamp and then continues live on the same connection, which is
 * exactly what is needed.
 *
 * 90 seconds is the balance point: about 4 MB and a couple of seconds to
 * ingest, for a window that immediately answers most of the example questions.
 * Five minutes would be ~19 MB, which is too much to spend before first paint.
 */
export const BACKFILL_SECONDS = 90;

/** Event types kept. `categorize` is bookkeeping noise that would double volume. */
const KEPT_TYPES = new Set(['edit', 'new', 'log']);

/** Sites with no language component in their domain. */
const NON_LANGUAGE_HOSTS = new Set(['www', 'commons', 'meta', 'species', 'incubator']);

const MAX_BACKOFF_MS = 30_000;

export interface IngestStats {
  connected: boolean;
  backfilling: boolean;
  eventsReceived: number;
  eventsKept: number;
  parseErrors: number;
  reconnects: number;
  lastError: string | null;
  medianLagSeconds: number | null;
}

interface RawEvent {
  type?: string;
  server_name?: string;
  title?: string;
  user?: string;
  bot?: boolean;
  minor?: boolean;
  namespace?: number;
  timestamp?: number;
  length?: { old?: number | null; new?: number | null } | null;
  comment?: string;
  meta?: { uri?: string; dt?: string; id?: string };
}

/**
 * Normalize one recentchange event into an `edits` row.
 *
 * Returns null for events to drop. Upstream fields are inconsistently present
 * across wikis, so every access is defensive: a missing `length` on one small
 * wiki must not stall the pipeline.
 */
export function parseEvent(raw: RawEvent): EditRow | null {
  const type = raw.type;
  if (!type || !KEPT_TYPES.has(type)) return null;

  const server = raw.server_name ?? '';
  if (!server) return null;

  // 'en.wikipedia.org' -> lang 'en', project 'wikipedia'. Sites like
  // 'commons.wikimedia.org' or 'www.wikidata.org' have no language component,
  // so they are labelled by project with lang '-'.
  const parts = server.split('.');
  let lang = '-';
  let project = parts.length >= 2 ? parts[1]! : server;
  if (parts.length >= 3 && !NON_LANGUAGE_HOSTS.has(parts[0]!)) {
    lang = parts[0]!;
    project = parts[1]!;
  }

  const length = raw.length ?? {};
  const oldLen = length.old ?? 0;
  const newLen = length.new ?? 0;
  // A page creation has no old length; the whole page counts as added.
  const delta = oldLen ? newLen - oldLen : newLen;

  let ts: number;
  if (typeof raw.timestamp === 'number') {
    ts = raw.timestamp;
  } else {
    const parsed = Date.parse(raw.meta?.dt ?? '');
    ts = Number.isNaN(parsed) ? Date.now() / 1000 : parsed / 1000;
  }

  const user = raw.user ?? '';

  return {
    ts,
    wiki: server,
    lang,
    project,
    type,
    title: raw.title ?? '',
    user,
    is_bot: Boolean(raw.bot),
    // The stream has no explicit anonymous flag; MediaWiki reports logged-out
    // edits with the IP address as the username.
    is_anon: looksLikeIp(user),
    is_minor: Boolean(raw.minor),
    namespace: Number(raw.namespace ?? 0),
    delta,
    new_len: newLen,
    comment: (raw.comment ?? '').slice(0, 280),
    uri: raw.meta?.uri ?? '',
  };
}

export function looksLikeIp(user: string): boolean {
  if (!user) return false;
  if (user.includes(':') && /^[0-9a-fA-F:]+$/.test(user)) return true; // IPv6
  const parts = user.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p));
}

/**
 * Owns the upstream connection and hands normalized rows to a sink.
 *
 * EventSource is used rather than fetch+ReadableStream because it handles SSE
 * framing, and it exists in workers. Its built-in reconnect is *not* used: it
 * would replay from the original `since` timestamp and flood the buffer with
 * duplicates. Reconnection is managed here instead, resuming from the last
 * event actually seen.
 */
export class FirehoseClient {
  readonly stats: IngestStats = {
    connected: false,
    backfilling: true,
    eventsReceived: 0,
    eventsKept: 0,
    parseErrors: 0,
    reconnects: 0,
    lastError: null,
    medianLagSeconds: null,
  };

  private source: EventSource | null = null;
  private buffer: EditRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private lastEventTs: number | null = null;
  private lagSamples: number[] = [];

  /** Recently seen event ids, so a resume cannot double-count. */
  private seen = new Set<string>();

  constructor(
    private readonly sink: (rows: EditRow[]) => void,
    private readonly url: string = STREAM_URL,
    private readonly flushIntervalMs = 400,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect(Date.now() / 1000 - BACKFILL_SECONDS);
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  private connect(sinceSeconds: number | null): void {
    if (this.stopped) return;

    let url = this.url;
    if (sinceSeconds !== null) {
      const iso = new Date(sinceSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      url += `?since=${encodeURIComponent(iso)}`;
    }

    const source = new EventSource(url);
    this.source = source;

    source.onopen = () => {
      this.stats.connected = true;
      this.stats.lastError = null;
      this.attempt = 0;
    };

    source.onmessage = (event) => this.handlePayload(event.data);

    source.onerror = () => {
      // EventSource reports errors without detail; any failure is treated the
      // same way, and its own retry is suppressed by closing the connection.
      this.stats.connected = false;
      source.close();
      if (this.stopped) return;

      this.stats.reconnects += 1;
      this.stats.lastError = 'Connection to the stream dropped.';
      this.attempt += 1;

      // Exponential backoff with jitter. Jitter matters: without it every
      // client restarted by an upstream blip retries in lockstep.
      const base = Math.min(MAX_BACKOFF_MS, 2 ** Math.min(this.attempt, 5) * 500);
      const delay = base * (0.5 + Math.random() / 2);

      this.reconnectTimer = setTimeout(() => {
        // Resume from the last event seen, so the gap is bounded and nothing
        // already ingested is replayed.
        this.connect(this.lastEventTs ?? Date.now() / 1000 - BACKFILL_SECONDS);
      }, delay);
    };
  }

  private handlePayload(payload: string): void {
    this.stats.eventsReceived += 1;

    let raw: RawEvent;
    try {
      raw = JSON.parse(payload);
    } catch {
      this.stats.parseErrors += 1;
      return;
    }

    const id = raw.meta?.id;
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
      // Bound the dedup set; it only needs to cover a reconnect's overlap.
      if (this.seen.size > 4000) {
        this.seen = new Set([...this.seen].slice(-2000));
      }
    }

    let row: EditRow | null;
    try {
      row = parseEvent(raw);
    } catch {
      this.stats.parseErrors += 1;
      return;
    }
    if (row === null) return;

    this.stats.eventsKept += 1;
    this.lastEventTs = Number(row.ts);

    const lag = Date.now() / 1000 - Number(row.ts);
    if (lag >= 0) {
      this.lagSamples.push(lag);
      if (this.lagSamples.length > 400) this.lagSamples.splice(0, 200);
    }

    // Once events are within a few seconds of now, the replay has caught up.
    if (this.stats.backfilling && lag < 5) this.stats.backfilling = false;

    this.buffer.push(row);
  }

  /**
   * Hand buffered rows to the sink in batches.
   *
   * Batching rather than appending per event keeps the number of store writes
   * and UI notifications to a couple per second instead of ~40, which is the
   * difference between a smooth page and one that fights the event loop.
   */
  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const sorted = [...this.lagSamples].sort((a, b) => a - b);
    this.stats.medianLagSeconds = sorted.length
      ? Number(sorted[sorted.length >> 1]!.toFixed(2))
      : null;

    this.sink(batch);
  }

  stop(): void {
    this.stopped = true;
    this.source?.close();
    this.source = null;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.stats.connected = false;
  }
}
