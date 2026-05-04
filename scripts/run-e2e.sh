#!/usr/bin/env bash
# Run the openclaw-plugin e2e suite against a freshly-booted dev server.
#
# What this does:
#   1. Sanity-check Postgres (DATABASE_URL must point at a DB with pgvector)
#   2. Build workspace packages if needed
#   3. Boot scripts/dev-native.sh in the background
#   4. Wait until /health responds
#   5. Run vitest (test/e2e/) inside packages/openclaw-plugin
#   6. Tear the server down on any exit path
#
# Pass ZAI_API_KEY in env to also run the LLM-driven memory-loop tests.
# Without it, those tests skip cleanly (12 of 14 still execute).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?Set DATABASE_URL=postgres://... (with pgvector) before running}"

PORT="${PORT:-8787}"
APP_URL="${APP_URL:-http://127.0.0.1:${PORT}}"
LOG="$(mktemp -t lobu-e2e-server.XXXXXX.log)"
PIDFILE="$(mktemp -t lobu-e2e-server.XXXXXX.pid)"

cleanup() {
  if [[ -s "$PIDFILE" ]]; then
    pid=$(cat "$PIDFILE")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # give it a couple seconds to drain, then force
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  pkill -f 'tsx watch.*src/server.ts' 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "  server log retained at: $LOG"
}
trap cleanup EXIT INT TERM

# 1. Postgres sanity
psql_args=(-d "$DATABASE_URL" -t -A -c "SELECT 1")
if ! psql "${psql_args[@]}" >/dev/null 2>&1; then
  echo "❌ Cannot reach Postgres via DATABASE_URL" >&2
  exit 1
fi
if ! psql -d "$DATABASE_URL" -t -A -c "SELECT 1 FROM pg_extension WHERE extname='vector'" | grep -q 1; then
  echo "❌ pgvector extension not installed in DATABASE_URL target" >&2
  echo "   Run: psql -d \"\$DATABASE_URL\" -c 'CREATE EXTENSION IF NOT EXISTS vector'" >&2
  exit 1
fi

# 2. Build packages if dist trees aren't there yet
if [[ ! -d packages/core/dist || ! -d packages/connector-sdk/dist || ! -d packages/agent-worker/dist ]]; then
  echo "📦 Building workspace packages…"
  make build-packages >/dev/null
fi

# 3. Boot the dev server (DATABASE_URL etc. are inherited)
echo "🚀 Booting dev server on $APP_URL (logs: $LOG)…"
( ./scripts/dev-native.sh >"$LOG" 2>&1 & echo $! > "$PIDFILE" ) || true

# 4. Wait for /health
deadline=$(( $(date +%s) + 60 ))
until curl -sf -m 2 "$APP_URL/health" >/dev/null 2>&1; do
  if [[ $(date +%s) -gt $deadline ]]; then
    echo "❌ Server did not become healthy within 60s. Last 30 log lines:" >&2
    tail -n 30 "$LOG" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "✅ Server healthy"

# 5. Run the e2e suite
echo "🧪 Running openclaw-plugin e2e…"
APP_URL="$APP_URL" \
  bun run --cwd packages/openclaw-plugin test:e2e
