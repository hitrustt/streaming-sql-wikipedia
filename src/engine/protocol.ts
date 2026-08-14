import type { QueryResult, ResultRow } from './executor';
import type { IngestStats } from './ingest';
import type { Preset } from './presets';
import type { Column, EditRow } from './schema';
import type { StoreStats } from './store';
import type { QueryErrorMessage, ResultMessage } from './subscriptions';

/** Messages exchanged between the UI thread and the engine worker. */

export interface SubscribeMessage {
  type: 'subscribe';
  id: string;
  sql: string;
}

export interface SetFeedMessage {
  type: 'setFeed';
  humanOnly: boolean;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  id: string;
}

export type ToWorker = SubscribeMessage | UnsubscribeMessage | SetFeedMessage;

export interface ReadyMessage {
  type: 'ready';
  presets: Preset[];
  columns: Column[];
}

export interface FeedMessage {
  type: 'feed';
  events: EditRow[];
  stats: StoreStats;
  ingest: IngestStats;
  headline: { columns: string[]; rows: ResultRow[] };
}

export type FromWorker = ReadyMessage | FeedMessage | ResultMessage | QueryErrorMessage;

export type { Column, EditRow, IngestStats, Preset, QueryResult, ResultRow, StoreStats };
