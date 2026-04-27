#!/bin/bash
set -e

MODE="${1:-server}"

echo "Starting Owletto backend (Node + tsx)"
echo "================================"

echo "Environment:"
echo "  DATABASE_URL: ${DATABASE_URL:+***set***}"
echo "  GITHUB_TOKEN: ${GITHUB_TOKEN:+***set***}"
echo "  JWT_SECRET: ${JWT_SECRET:+***set***}"

run_migrations() {
  if [ -z "$DATABASE_URL" ]; then
    echo "ERROR: DATABASE_URL not set"
    exit 1
  fi

  echo ""
  echo "Running database migrations..."
  dbmate --url "$DATABASE_URL" --migrations-dir /app/db/migrations --no-dump-schema up
  echo "Migrations complete"
}

if [ "$MODE" = "migrate" ]; then
  run_migrations
  exit 0
fi

echo ""
echo "Starting backend on port 8787..."

# When the Helm chart's pre-upgrade migration Job is enabled, it has
# already applied migrations before this Deployment is rolled. Set
# SKIP_MIGRATIONS=1 in that environment so the per-pod start doesn't
# block on a migration that may take longer than livenessProbe allows.
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "SKIP_MIGRATIONS=1 — assuming the pre-upgrade Job applied migrations."
else
  run_migrations
fi

# Run under Node so V8 native addons (isolated-vm) load.
# Bun uses JavaScriptCore and cannot link the V8 ABI surface that
# isolated-vm requires; the execute MCP tool silently degrades to
# RuntimeUnavailable under bun. tsx provides the TS loader so the
# source layout stays uncompiled.
#
# Keep cwd=/app — gateway services and embedded agent routes resolve
# bundled config (`config/providers.json`) relative to process.cwd().
# Use the absolute tsx loader path so the resolution doesn't depend
# on cwd or PATH.
exec node \
  --import "file:///app/packages/owletto-backend/node_modules/tsx/dist/loader.mjs" \
  /app/packages/owletto-backend/src/server.ts
