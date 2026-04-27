#!/bin/bash
set -e

MODE="${1:-server}"

echo "Starting Owletto backend (Bun)"
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

# NOTE: prod runs under Bun. The execute MCP tool requires V8
# (isolated-vm), which Bun's JSC ABI shim cannot load. PR #430 attempted
# to switch the runtime to `node --import tsx`, but exposed a CJS/ESM
# interop gap: Node's cjs-module-lexer doesn't detect new named exports
# of @lobu/core's CJS dist when the static import follows certain
# reachability paths (e.g. the full server.ts boot chain hits
# `SyntaxError: ... does not provide an export named 'createBuiltinSecretRef'`,
# even though a same-imports test entry resolves fine). Reverted on the
# understanding that fixing properly means making @lobu/core (and other
# workspace packages) ship dual ESM+CJS output instead of CJS-only with
# an `import` condition. Tracked separately.
exec bun /app/packages/owletto-backend/src/server.ts
