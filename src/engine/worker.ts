/// <reference lib="webworker" />

import { runQuery } from './executor';
import { FirehoseClient } from './ingest';
import { parse } from './parser';
import { HEADLINE_SQL, PRESETS } from './presets';
import type { FromWorker, ToWorker } from './protocol';
import { COLUMNS } from './schema';
import { EventStore } from './store';
import { Subscription } from './subscriptions';

/**
 * The engine, running off the main thread.
 *
 * Everything expensive lives here: the stream connection, the ring buffer, and
 * query execution. That separation is the whole reason the UI stays responsive
 * -- a grouped scan over tens of thousands of rows takes tens of milliseconds,
 * which on the main thread would drop frames every single tick and make typing
 * in the editor feel sticky.
 *
 * The worker owns all state. The UI holds only what it renders.
 */

const store = new EventStore();
const subscriptions = new Map<string, Subscription>();

let humanOnly = true;
let lastFeedAt = 0;

/** How often the live feed and header stats are pushed. */
const FEED_INTERVAL_MS = 1000;

const client = new FirehoseClient((rows) => store.appendMany(rows));

function post(message: FromWorker): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;

  switch (message.type) {
    case 'subscribe': {
      // Validate immediately so a typo is reported on submit rather than a
      // second later on the first tick.
      try {
        parse(message.sql);
      } catch (err) {
        const e = err as { message: string; start?: number; end?: number; hint?: string | null };
        post({
          type: 'queryError',
          id: message.id,
          error: {
            message: e.message,
            start: e.start ?? 0,
            end: e.end ?? 0,
            hint: e.hint ?? null,
          },
        });
        return;
      }
      subscriptions.set(message.id, new Subscription(message.id, message.sql));
      return;
    }

    case 'unsubscribe':
      subscriptions.delete(message.id);
      return;

    case 'setFeed':
      humanOnly = message.humanOnly;
      return;

    default:
      return;
  }
};

/**
 * The engine loop.
 *
 * A plain interval rather than requestAnimationFrame: workers have no frame
 * clock, and the loop should keep running at the same rate when the tab is in
 * the background so the buffer stays current. Browsers throttle background
 * timers, which is a feature here -- a hidden tab should not burn CPU.
 */
function tick(): void {
  const now = Date.now();

  for (const subscription of subscriptions.values()) {
    if (subscription.due(now)) post(subscription.evaluate(store));
  }

  if (now - lastFeedAt >= FEED_INTERVAL_MS) {
    lastFeedAt = now;
    let headline: { columns: string[]; rows: ReturnType<typeof runQuery>['rows'] };
    try {
      const result = runQuery(HEADLINE_SQL, store);
      headline = { columns: result.columns, rows: result.rows };
    } catch {
      // The header must never be the thing that breaks the page.
      headline = { columns: [], rows: [] };
    }

    post({
      type: 'feed',
      events: store.recent(14, humanOnly),
      stats: store.stats(),
      ingest: client.stats,
      headline,
    });
  }
}

client.start();
setInterval(tick, 150);

post({
  type: 'ready',
  presets: [...PRESETS],
  columns: [...COLUMNS],
});
