#!/usr/bin/env bash
#
# SDK lifecycle end-to-end gate.
#
# Proves the WHOLE TypeScript-SDK path actually runs — not just that config maps
# correctly (unit/integration cover that), but that `lobu run` boots, auto-applies
# a project, exercises prune, and an agent completes a real turn through a spawned
# worker. Runs against a DETERMINISTIC mock OpenAI-compatible provider (see
# scripts/sdk-e2e/), so it needs no provider key and is reproducible in CI.
#
# It asserts, failing (non-zero exit → red CI) on any miss:
#   1. lobu run auto-applies the fixture → "Apply complete" (NOT halted). With a
#      prune:true fixture this also guards the system-type ($member) exemption —
#      an un-exempted prune halts every apply.
#   2. every declared definition is created (agent, entity/relationship types,
#      watcher).
#   3. `lobu chat` drives a real turn through the worker → the mock's reply.
#   4. a stable re-apply is idempotent (0 deletes).
#
# Usage: scripts/sdk-e2e.sh         (embedded Postgres, the default)
#        DATABASE_URL=... scripts/sdk-e2e.sh   (use an external Postgres)
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$WT/scripts/sdk-e2e"
LOBU="node $WT/packages/cli/bin/lobu.js"
GW_PORT="${GW_PORT:-8793}"
MOCK_PORT="${MOCK_PORT:-11434}"
MOCK_REPLY="SDK_E2E_OK"
RUN_DIR="$WT/.sdk-e2e-run"
RUN_LOG="$RUN_DIR/run.log"
MOCK_LOG="$RUN_DIR/mock.log"
CHAT_OUT="$RUN_DIR/chat.out"

# Node 22-24 is required (the worker uses isolated-vm). Prefer a Homebrew node@22
# locally; CI provides node via actions/setup-node.
if [ -x /opt/homebrew/opt/node@22/bin/node ] && ! node --version 2>/dev/null | grep -qE '^v(22|23|24)\.'; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi

MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null || true
  lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  lsof -nP -iTCP:"$MOCK_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "❌ SDK e2e FAILED: $*" >&2; [ -f "$RUN_LOG" ] && { echo "--- last 40 lines of run.log ---" >&2; tail -40 "$RUN_LOG" >&2; }; exit 1; }

echo "▶ node $(node --version), gateway :$GW_PORT, mock :$MOCK_PORT"
rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR"
cleanup  # free ports from any prior run

# 1) Mock OpenAI-compatible provider.
MOCK_PORT="$MOCK_PORT" MOCK_REPLY="$MOCK_REPLY" node "$HARNESS/mock-openai.mjs" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
disown "$MOCK_PID" 2>/dev/null || true  # silence job-control "Killed" on cleanup
for _ in $(seq 1 20); do
  curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" -H 'content-type: application/json' -d '{}' >/dev/null 2>&1 || fail "mock server did not come up"
echo "✓ mock provider up"

# 2) Scaffold a project (inside the repo so jiti resolves the workspace @lobu/sdk).
PROJ="$RUN_DIR/proj"; mkdir -p "$PROJ"
( cd "$PROJ" && $LOBU init . -y --here --provider gemini >/dev/null 2>&1 )
rm -f "$PROJ/package.json"
cat > "$PROJ/lobu.config.ts" <<'TS'
import { defineAgent, defineConfig, defineEntityType, defineRelationshipType, defineWatcher, secret } from "@lobu/sdk";

const agent = defineAgent({
  id: "echo", name: "Echo", dir: "./agents/echo",
  providers: [{ id: "mock", model: "mock-model", key: secret("MOCK_API_KEY") }],
});
const company = defineEntityType({ key: "company", name: "Company" });
const contact = defineEntityType({ key: "contact", name: "Contact" });
const worksAt = defineRelationshipType({ key: "works-at", name: "Works at", rules: [{ source: contact, target: company }] });
const digest = defineWatcher({
  slug: "digest", agent, name: "Digest", prompt: "summarize",
  extractionSchema: { type: "object", properties: { s: { type: "string" } } },
});

// prune:true so the gate exercises the destructive path on every run (this is
// what catches the system-type $member halt class of bug).
export default defineConfig({ prune: true, agents: [agent], entities: [company, contact], relationships: [worksAt], watchers: [digest] });
TS

# Project env: mock key, allow loopback egress (mock provider), embedded PG unless
# DATABASE_URL was provided. Lead with a newline so the first line can't glue
# onto a scaffolded .env that lacks a trailing newline.
{
  printf '\n'
  echo "MOCK_API_KEY=mock-key-e2e"
  echo "WORKER_ALLOWED_DOMAINS=127.0.0.1,localhost"
  # The orchestrator wraps Linux workers in `systemd-run --user --scope` for
  # cgroup/network limits; CI runners have no user systemd session, so that
  # spawn fails. Disable it here — the worker only talks to the loopback mock,
  # and this gate isn't testing the prod network sandbox. No-op on macOS.
  echo "LOBU_DISABLE_SYSTEMD_RUN=1"
  [ -n "${DATABASE_URL:-}" ] && echo "DATABASE_URL=$DATABASE_URL"
} >> "$PROJ/.env"

export LOBU_PROVIDER_REGISTRY_PATH="$HARNESS/providers.json"

# 3) Boot lobu run — it auto-applies the project (the apply + prune E2E).
( cd "$PROJ" && $LOBU run --port "$GW_PORT" > "$RUN_LOG" 2>&1 ) &
for _ in $(seq 1 80); do
  grep -qiE "Apply complete|auto-apply skipped|Apply halted" "$RUN_LOG" 2>/dev/null && break
  sleep 1
done

grep -qi "Apply complete" "$RUN_LOG" || fail "auto-apply did not complete (skipped/halted?)"
grep -qiE "Apply halted" "$RUN_LOG" && fail "apply halted on a failure"
echo "✓ lobu run auto-applied the project (Apply complete)"

# 2b) Every declared definition created.
for marker in "+ entity-type company" "+ entity-type contact" "+ relationship-type works-at" "+ watcher digest"; do
  grep -qF "$marker" "$RUN_LOG" || fail "expected created definition not in plan: '$marker'"
done
# System $member must be ignorable drift, never a delete row (the prune-halt bug).
grep -qiE "entity-type .member \(removed from config — will be deleted\)|delete.*\\\$member" "$RUN_LOG" && fail "prune tried to delete the system \$member type"
echo "✓ all definitions created; \$member not pruned"

# 4) A real agent turn through the worker.
( cd "$PROJ" && timeout 90 $LOBU chat "say the safe word" -c local > "$CHAT_OUT" 2>&1 ) || fail "lobu chat exited non-zero"
grep -qF "$MOCK_REPLY" "$CHAT_OUT" || fail "agent turn did not return the mock reply '$MOCK_REPLY' (got: $(tr -d '\n' < "$CHAT_OUT" | tail -c 200))"
grep -qiE "Forwarding to upstream: POST http://127.0.0.1:$MOCK_PORT" "$RUN_LOG" || fail "worker never called the mock provider upstream"
echo "✓ agent completed a real turn through the worker (reply: $MOCK_REPLY)"

# 5) Idempotent re-apply (stable config → 0 deletes). Unlike `lobu run`, `lobu
# apply` does not auto-load the project .env, so pass the secret it resolves for
# the provider-key push explicitly.
REAPPLY="$RUN_DIR/reapply.out"
( cd "$PROJ" && MOCK_API_KEY=mock-key-e2e $LOBU apply --url "http://localhost:$GW_PORT" --yes > "$REAPPLY" 2>&1 ) || { cat "$REAPPLY" >&2; fail "re-apply exited non-zero"; }
# A fully-idempotent re-apply prints "Nothing to apply." (everything noop/drift);
# a partial one prints "Apply complete.". Either is fine — a delete row is not.
grep -qiE "Nothing to apply|Apply complete" "$REAPPLY" || { cat "$REAPPLY" >&2; fail "re-apply neither completed nor was a noop"; }
if grep -qE "Summary:.*[1-9][0-9]* delete" "$REAPPLY"; then fail "re-apply was not idempotent (deleted something on a stable config)"; fi
echo "✓ re-apply is idempotent (no deletes on a stable config)"

echo "✅ SDK lifecycle e2e PASSED"
