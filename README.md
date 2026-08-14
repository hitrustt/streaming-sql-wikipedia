# Riverbed (https://riverbed.fly.dev/)

Riverbed is a streaming SQL engine for Wikipedia's live edit stream, built with Python, FastAPI, React, and TypeScript. It ingests every edit made across Wikimedia, keeps a rolling window in memory, and runs continuous SQL queries over it that update once a second in the browser.

The SQL engine is written from scratch. There is no database and no query library.

### Desktop

![Riverbed](./docs/screenshot.png)

## Features

- Live SQL over a stream of 20–50 edits per second
- Continuous queries that update as new edits arrive
- One-click example questions, editable as SQL
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

Supports `WHERE`, `GROUP BY`, `ORDER BY`, `LIMIT`, `LIKE`, `IN`, `CASE WHEN`, and aliases. Aggregates are `count`, `count(distinct)`, `sum`, `avg`, `min`, `max`, `percentile`, and `top_k`.

`WINDOW 5m` sets the rolling window. Joins, subqueries, and `HAVING` are not supported.

## Running Locally

Backend:

```bash
cd server
pip install -r requirements.txt
python -m uvicorn riverbed.app:app --reload --port 8000
```

Frontend, in a second terminal:

```bash
cd web
npm install
npm run dev
```

To build the frontend into the server and run it on one port:

```bash
cd web
npm run build
cd ../server
python -m uvicorn riverbed.app:app --port 8000
```

Tests:

```bash
cd server
python -m pytest
```

## Deploying

The Dockerfile builds the frontend and serves it from the Python process.

```bash
fly deploy
```

Run one instance. The event buffer and the upstream connection live in process memory, so multiple workers would each open their own connection and return different results.

## How It Works

```
Wikimedia EventStreams (SSE)
  -> ingest: reconnect, normalize, batch
  -> store: columnar ring buffer, 30 min / 250k rows
  -> sql: lexer, parser, planner, executor
  -> websocket: only the rows that changed
```

Queries re-scan the window each tick rather than maintaining incremental aggregates. A full scan of a bounded window is simpler to get right, and takes tens of milliseconds.

Longer time ranges are answered from per-minute rollups using HyperLogLog for distinct counts, Count-Min for heavy hitters, and t-digest for percentiles. All three are implemented in `server/riverbed/sketches.py` and tested against exact values.

## Data

[Wikimedia EventStreams](https://stream.wikimedia.org/v2/stream/recentchange), a public feed of every edit to every Wikimedia wiki.

About 58% of the stream is bots, and most of the rest is Wikidata and Commons rather than Wikipedia articles. The default views filter to `is_bot = false AND project = 'wikipedia' AND namespace = 0` so the results are readable. Bot activity is still queryable, and two of the example questions use the unfiltered stream.
