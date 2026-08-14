# Riverbed (https://hitrustt.github.io/streaming-sql-wikipedia/)

Riverbed is a live query tool for streaming data, built with React, TypeScript, and Web Workers. It connects to Wikipedia's public edit stream, keeps a rolling window of it in memory, and runs continuous SQL queries that update every second.

The query engine is written from scratch: tokenizer, parser, planner, and executor. There is no database, no query library, and no backend server. Everything runs in the browser.

## Features

- Live SQL over a stream of 20–50 edits per second
- Continuous queries that update as new records arrive
- One-click example questions, each editable as SQL
- Live feed of edits linking to the real articles

## Query Language

One table, `edits`, with 15 columns.

```sql
SELECT lang, count(*) AS edits, count(distinct user) AS editors
FROM edits
WHERE is_bot = false AND namespace = 0
GROUP BY lang
ORDER BY edits DESC
LIMIT 10
WINDOW 5m
```

Supports `WHERE`, `GROUP BY`, `ORDER BY`, `LIMIT`, `LIKE`, `IN`, `IS NULL`, `CASE WHEN`, and aliases. Aggregates are `count`, `count(distinct)`, `sum`, `avg`, `min`, `max`, `percentile`, and `top_k`.

`WINDOW 5m` sets the rolling window, which is what makes a query continuous rather than a one-shot scan. Joins, subqueries, and `HAVING` are not supported.

## Running Locally

```bash
npm install
npm run dev
```

To preview the production build:

```bash
npm run build
npm run preview
```

Tests:

```bash
npm test
```

There is also an integration test that reads the real stream and runs every example query against it. It is excluded from `npm test` so a network failure can never break the build:

```bash
npx vitest run src/engine/live.integration.test.ts
```

## Deploying

Pushing to `main` or `master` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`. The workflow runs the tests first and stops the deploy if they fail.

Since there is no server, hosting is a static file server and nothing else.

## How It Works

```
Wikimedia EventStreams (SSE)  ── browser connects directly
  -> ingest: backfill, normalize, batch, reconnect
  -> store: columnar ring buffer, 15 min / 80k rows
  -> sql: lexer, parser, planner, executor
  -> UI: only the rows that changed
```

Everything above runs in a Web Worker. A grouped scan over tens of thousands of rows takes tens of milliseconds, which on the main thread would drop frames every tick and make typing feel sticky.

Queries re-scan the window each tick instead of maintaining incremental aggregates. Incremental aggregation is where streaming engines hide their worst bugs (retraction when a window expires, out-of-order arrivals, aggregates like `min` that cannot be undone), and a full scan of a bounded window is simple to get right. Incrementality is applied where it is safe instead: the worker diffs each result against the last and sends only changed rows.

Longer time ranges are answered from per-minute rollups using HyperLogLog for distinct counts, Count-Min for heavy hitters, and t-digest for percentiles. All three are in `src/engine/sketches.ts` and tested against exact values. They use a 32-bit hash rather than the usual 64-bit one, because JavaScript numbers hold 53 bits of integer precision and BigInt is far too slow for a per-row loop.

The buffer is empty when the page loads, so the client replays the last 90 seconds on startup using the stream's `since` parameter. That is about 4 MB and a couple of seconds, and it means results are on screen almost immediately instead of after several minutes of waiting for the window to fill.

## Data

[Wikimedia EventStreams](https://stream.wikimedia.org/v2/stream/recentchange), a public feed of every edit to every Wikimedia wiki. It is served with `access-control-allow-origin: *`, which is why the browser can read it directly and the project needs no backend.

About 58% of the stream is bots, and most of the rest is Wikidata and Commons rather than Wikipedia articles. The default views filter to `is_bot = false AND project = 'wikipedia' AND namespace = 0` so the results are readable. Bot activity is still queryable, and two of the example questions use the unfiltered stream.
