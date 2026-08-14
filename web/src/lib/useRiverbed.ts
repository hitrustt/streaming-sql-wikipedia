import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Column,
  type EditEvent,
  type IngestStats,
  type LiveResult,
  type Preset,
  type QueryMeta,
  type Row,
  type ServerMessage,
  type StoreStats,
  emptyResult,
} from './types';

const SUB_ID = 'main';

/** Reconnect backoff ladder, in milliseconds. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000];

function socketUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

export interface RiverbedState {
  connected: boolean;
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

export function useRiverbed(): RiverbedState {
  const [connected, setConnected] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [stats, setStats] = useState<StoreStats | null>(null);
  const [ingest, setIngest] = useState<IngestStats | null>(null);
  const [events, setEvents] = useState<EditEvent[]>([]);
  const [headline, setHeadline] = useState<Row | null>(null);
  const [headlineColumns, setHeadlineColumns] = useState<string[]>([]);
  const [result, setResult] = useState<LiveResult>(emptyResult);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // The query to (re)subscribe to. Held in a ref so a reconnect can restore the
  // user's query without the connect effect depending on it and reconnecting
  // every time they type.
  const sqlRef = useRef<string | null>(null);
  const closedRef = useRef(false);
  // Mirrors the server default, and is re-sent on reconnect so the preference
  // survives a dropped socket.
  const humanOnlyRef = useRef(true);

  const subscribe = useCallback((sql: string) => {
    sqlRef.current = sql;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'subscribe', id: SUB_ID, sql }));
    }
  }, []);

  const setHumanOnly = useCallback((humanOnly: boolean) => {
    humanOnlyRef.current = humanOnly;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'set_feed', enabled: true, human_only: humanOnly }));
    }
  }, []);

  useEffect(() => {
    closedRef.current = false;

    const connect = () => {
      if (closedRef.current) return;
      const socket = new WebSocket(socketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
        socket.send(
          JSON.stringify({ type: 'set_feed', enabled: true, human_only: humanOnlyRef.current }),
        );
        if (sqlRef.current) {
          socket.send(JSON.stringify({ type: 'subscribe', id: SUB_ID, sql: sqlRef.current }));
        }
      };

      socket.onclose = () => {
        setConnected(false);
        socketRef.current = null;
        if (closedRef.current) return;
        const delay = BACKOFF[Math.min(attemptRef.current, BACKOFF.length - 1)] ?? 15000;
        attemptRef.current += 1;
        timerRef.current = window.setTimeout(connect, delay);
      };

      // An error is always followed by a close event, which owns the retry.
      socket.onerror = () => socket.close();

      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }
        handleMessage(message);
      };
    };

    const handleMessage = (message: ServerMessage) => {
      switch (message.type) {
        case 'welcome':
          setPresets(message.presets);
          setColumns(message.columns);
          setStats(message.stats);
          setIngest(message.ingest);
          break;

        case 'feed':
          setEvents(message.events);
          setStats(message.stats);
          setIngest(message.ingest);
          setHeadlineColumns(message.headline.columns);
          setHeadline(message.headline.rows[0] ?? null);
          break;

        case 'result':
          if (message.id !== SUB_ID) break;
          setResult((previous) => applyResult(previous, message));
          break;

        case 'query_error':
          if (message.id !== SUB_ID) break;
          setResult((previous) => ({ ...previous, error: message.error }));
          break;

        default:
          break;
      }
    };

    connect();

    return () => {
      closedRef.current = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, []);

  return {
    connected,
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
 * This is the client half of the delta protocol: the server sends only what
 * changed, and this reconstructs the full table locally. Keeping rows in a Map
 * keyed by the server's row key -- rather than an array -- is what makes an
 * update O(changed) instead of O(rows), and lets the table diff which cells to
 * flash.
 */
function applyResult(
  previous: LiveResult,
  message: Extract<ServerMessage, { type: 'result' }>,
): LiveResult {
  const meta: QueryMeta = { ...message.meta, columns: message.columns };

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
