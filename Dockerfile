# Two-stage build: compile the frontend, then copy the built assets into the
# Python image so a single container serves both the API and the UI. One
# process means one upstream firehose connection, which is what Wikimedia's
# client guidance asks for and the only arrangement that scales past a few tabs.

FROM node:20-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/riverbed ./riverbed
# vite.config.ts writes to '../server/riverbed/static', which from the web
# stage's /build workdir resolves to /server/riverbed/static.
COPY --from=web /server/riverbed/static ./riverbed/static

# Run unprivileged.
RUN useradd --create-home --uid 10001 riverbed
USER riverbed

EXPOSE 8000

# The health check reports unhealthy when the upstream stream goes silent, so a
# wedged ingest gets restarted rather than serving a frozen dashboard forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

# A single worker is required, not a default: the store and the firehose
# connection live in process memory, so multiple workers would each open their
# own upstream connection and serve inconsistent results.
CMD ["sh", "-c", "python -m uvicorn riverbed.app:app --host 0.0.0.0 --port ${PORT} --workers 1 --timeout-graceful-shutdown 10"]
