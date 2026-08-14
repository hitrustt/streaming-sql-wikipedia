import { useCallback, useEffect, useRef, useState } from 'react';
import type { FromWorker, ToWorker } from '../engine/protocol';
import {
  type Column,
  type EditEvent,
  type IngestStats,
  type LiveResult,
  type Preset,
  type QueryMeta,
  type Row,
  type StoreStats,
  emptyResult,
} from './types';

const SUB_ID = 'main';

export interface RiverbedState {
  ready: boolean;
  presets: Preset[];
  columns: Column[];
  stats: StoreStats | null;
  ingest: IngestStats | null;
  events: EditEvent[];
  headline: Row | null;
  headlineColumns: string[];
  result: LiveResult;
  subscribe: (sql: string) => void;
  setHumanOnly: (humanOnly: boolean) => void;
}

/**
 * Owns the engine worker and mirrors its state into React.
 *
 * There is no server and no socket: the worker connects to Wikimedia directly,
 * holds the buffer, and runs queries. This hook is a thin translation layer
 * between worker messages and render state.
 */
export function useRiverbed(): RiverbedState {
  const [ready, setReady] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [ingest, setIngest] = useState<IngestStats | null>(null);
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [headline, setHeadline] = useState<Row | null>(null);
  const [headlineColumns, setHeadlineColumns] = useState<string[]>([]);
  const [result, setResult] = useState<LiveResult>(emptyResult);

  const workerRef = useRef<Worker | null>(null);
  // Queued until the worker reports ready, so a subscription issued during
  // startup is not silently dropped.
  const pendingRef = useRef<ToWorker[]>([]);
  const readyRef = useRef(false);

  const send = useCallback((message: ToWorker) => {
    if (readyRef.current && workerRef.current) workerRef.current.postMessage(message);
    else pendingRef.current.push(message);
  }, []);

  useEffect(() => {
    // `new URL(..., import.meta.url)` is what lets the bundler fingerprint the
    // worker file and emit it as its own chunk, which is required for it to
    // load from a static host under a subpath.
    const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;

      switch (message.type) {
        case 'ready': {
          setPresets(message.presets);
          setColumns(message.columns);
          readyRef.current = true;
          setReady(true);
          for (const queued of pendingRef.current) worker.postMessage(queued);
          pendingRef.current = [];
          break;
        }

        case 'feed':
          setEvents(message.events as unknown as EditEvent[]);
          setStats(message.stats);
          setIngest(message.ingest);
          setHeadlineColumns(message.headline.columns);
          setHeadline(message.headline.rows[0] ?? null);
          break;

        case 'result':
          if (message.id !== SUB_ID) break;
          setResult((previous) => applyResult(previous, message));
          break;

        case 'queryError':
          if (message.id !== SUB_ID) break;
          setResult((previous) => ({ ...previous, error: message.error }));
          break;

        default:
          break;
      }
    };

    return () => {
      readyRef.current = false;
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const subscribe = useCallback(
    (sql: string) => send({ type: 'subscribe', id: SUB_ID, sql }),
    [send],
  );

  const setHumanOnly = useCallback(
    (humanOnly: boolean) => send({ type: 'setFeed', humanOnly }),
    [send],
  );

  return {
    ready,
    presets,
    columns,
    stats,
    ingest,
    events,
    headline,
    headlineColumns,
    result,
    subscribe,
    setHumanOnly,
  };
}

/**
 * Fold a full snapshot or a delta message into the local result set.
 *
 * This is the client half of the delta protocol: the worker sends only what
 * changed, and this reconstructs the table. Keeping rows in a Map keyed by the
 * worker's row key -- rather than an array -- makes an update O(changed) instead
 * of O(rows), and lets the table know which cells to flash.
 */
function applyResult(
  previous: LiveResult,
  message: Extract<FromWorker, { type: 'result' }>,
): LiveResult {
  const meta = message.meta as unknown as QueryMeta;

  if (message.full) {
    const keys = message.keys ?? [];
    const rows = new Map<string, Row>();
    (message.rows ?? []).forEach((row, index) => {
      const key = keys[index];
      if (key !== undefined) rows.set(key, row);
    });
    return { columns: message.columns, keys, rows, meta, changed: new Set(), error: null };
  }

  const rows = new Map(previous.rows);
  const changed = new Set<string>();

  for (const delta of message.deltas ?? []) {
    if (delta.op === 'remove') {
      rows.delete(delta.key);
    } else if (delta.row) {
      rows.set(delta.key, delta.row);
      changed.add(delta.key);
    }
  }

  return {
    columns: message.columns,
    // A null `keys` means the ordering did not change this tick.
    keys: message.keys ?? previous.keys,
    rows,
    meta,
    changed,
    error: null,
  };
}
