import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { runQuery } from './executor';
import { BACKFILL_SECONDS, STREAM_URL, parseEvent } from './ingest';
import { PRESETS } from './presets';
import type { EditRow } from './schema';
import { EventStore } from './store';

/**
 * Integration test against the real Wikimedia firehose.
 *
 * Excluded from the default run (and from CI) because it depends on the network
 * and on Wikimedia being up; a unit suite that can fail for those reasons is
 * worse than no suite. Run it explicitly:
 *
 *   npx vitest run src/engine/live.integration.test.ts
 *
 * It reads the stream with fetch rather than EventSource -- EventSource does not
 * exist in Node -- which exercises everything except the browser transport
 * itself: the `since` backfill, SSE framing, event normalization, the store, and
 * every preset query against real data.
 */

async function collectFromStream(seconds: number, maxEvents: number): Promise<EditRow[]> {
  const since = new Date(Date.now() - BACKFILL_SECONDS * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);

  const rows: EditRow[] = [];
  try {
    const response = await fetch(`${STREAM_URL}?since=${encodeURIComponent(since)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.ok).toBe(true);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (rows.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const row = parseEvent(JSON.parse(line.slice(5).trim()));
            if (row) rows.push(row);
          } catch {
            // A malformed event must not stop the pipeline.
          }
        }
        split = buffer.indexOf('\n\n');
      }
    }

    await reader.cancel();
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
  }

  return rows;
}

/**
 * Collects a human-readable report.
 *
 * Written to a file rather than logged: test runners suppress console output by
 * default, and the point of this test is as much to *show* real results as to
 * assert on them.
 */
const report: string[] = [];
const log = (line = '') => report.push(line);

afterAll(() => {
  writeFileSync('live-report.txt', report.join('\n'), 'utf8');
});

describe('live stream', () => {
  it('ingests real events and answers every preset', async () => {
    const rows = await collectFromStream(30, 6000);
    log(`collected ${rows.length} real events`);
    expect(rows.length).toBeGreaterThan(200);

    const store = new EventStore();
    store.appendMany(rows);

    const stats = store.stats();
    log(`buffered ${stats.bufferedRows}, ${stats.eventsPerSecond}/s\n`);
    expect(stats.bufferedRows).toBeGreaterThan(0);

    // Every normalized row must be well-formed, or a query will produce
    // nonsense rather than an error.
    for (const row of rows.slice(0, 200)) {
      expect(typeof row.ts).toBe('number');
      expect(Number.isFinite(row.ts as number)).toBe(true);
      expect(typeof row.title).toBe('string');
      expect(typeof row.delta).toBe('number');
      expect(Number.isFinite(row.delta as number)).toBe(true);
      expect(typeof row.is_bot).toBe('boolean');
    }

    for (const preset of PRESETS) {
      const result = runQuery(preset.sql, store);
      log(
        `${preset.label.padEnd(28)} ${String(result.rows.length).padStart(3)} rows  ` +
        `${result.elapsedMs.toFixed(1)}ms  (scanned ${result.scanned})`,
      );
      expect(result.elapsedMs).toBeLessThan(1000);
      for (const row of result.rows) expect(row.length).toBe(result.columns.length);
    }

    const human = runQuery(
      "SELECT title, lang FROM edits WHERE is_bot = false AND project = 'wikipedia' " +
      'AND namespace = 0 LIMIT 8',
      store,
    );
    log('\nsample of human article edits:');
    for (const row of human.rows) log(`  [${String(row[1]).padStart(3)}] ${row[0]}`);
    expect(human.rows.length).toBeGreaterThan(0);
  }, 90_000);
});
