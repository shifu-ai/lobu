# `lobu apply` — Plan

Status: **planning** · Owner: @buremba · Reviewed against pi second-opinion 2026-04-30

## Goal

Provide a reliable, one-way `lobu.toml` → Lobu Cloud org converger. Mental model: `terraform apply`. Files declare desired state, the CLI shows a plan, the user confirms, the server transactionally applies.

Out of scope for v1: `lobu pull` (cloud → files), bulk memory data, raw skill round-trip, secrets push.

## Background

Today the repo has two coherent runtime modes — **file-first local** (`lobu run` reads `lobu.toml` into `InMemoryAgentStore`) and **DB-first cloud** (web UI writes `agent_connections` etc. via Hono routes). There is no bridge. `lobu memory seed` (PR #459) is the closest precedent — it walks `models/` + `data/` and pushes via REST, but is only for memory data and has reliability footguns documented below.

We want a verb that takes a project directory and converges a Cloud org to match it.

## Locked decisions

1. **Verb is `lobu apply`** (not `sync`). One-way semantics, terraform-flavored. Leaves room for a future `lobu pull` without naming collision.
2. **Default flow**: render diff → prompt → apply. `--dry-run` prints diff and exits. `--prune` includes deletes in the diff (otherwise drift in cloud is flagged but never deleted). `--force` overwrites drifted resources without prompting.
3. **Server-driven, not CLI-CRUD-loop**. The CLI calls `POST /api/:orgSlug/apply/plan` and `POST /api/:orgSlug/apply`. The server normalizes desired state, computes the diff, acquires an org lock, applies in a transaction, and returns structured per-resource results. **No CLI-side fan-out over five different endpoints** — that produces partial failures with no recovery.
4. **State tracking via `applied_state` table** (resource key + `desired_hash` + `last_applied_hash` + `live_hash` + `managed_by = 'lobu-apply'`). Drift = `last_applied != live`. `--prune` only deletes apply-managed resources. UI-created resources are flagged as drift but never silently overwritten.
5. **Skills**: normalized via the existing file-loader transformation into `agents.skills_config`. Raw `SKILL.md` round-trip is v2 (needs `lobu pull`).
6. **Secrets**: deferred to v3. v1 reads `$VAR` references in `lobu.toml`, queries the org's secret-proxy for whether the named secrets exist, and **fails the plan loudly if any are missing**. v1 never reads `.env` and never uploads values.
7. **Memory data deferred to v3**. v1 ships memory **schema** (entity + relationship types). Watchers, entities, relationships, knowledge are out — different cadence, different perf profile, need streaming/resume.
8. **Connections in v1 are gated on D**. If the stable-id upsert API ships, v1 includes connections; otherwise v1 is plan-only for connections (diff renders, apply errors with a clear "ship D first" message).

## Phasing — what ships when

### v1 (this plan)

CLI-visible:
- `lobu apply [--dry-run] [--prune] [--force] [--only agents|memory] [--org <slug>]`
- Resources: agents (metadata + prompt files + settings), local skills (normalized into `skills_config`), provider declarations + availability check, memory entity types, memory relationship types, connections (if D ships).
- Diff renderer with create/update/delete/drift markers.
- State tracking via `applied_state`.

### v2 — landed after v1 has real-world use

- `lobu pull` for cloud → files (drift recovery)
- Connections (if D didn't make v1)
- Watchers
- Raw `SKILL.md` round-trip (needs richer cloud-side storage for frontmatter + non-`SKILL.md` files in skill dirs)

### v3 — risk-controlled additions

- `lobu secrets push` (separate verb): per-key confirmation, fingerprint-only display, audit per write, org-scoped names, `missing-only` default, explicit `--rotate`/`--overwrite`
- Bulk memory data with resume tokens, streaming, idempotent re-application

## v1 work breakdown — five PRs, four can parallelize

Each PR is a separate branch off `main`, opens a draft PR. Subagents work in isolated worktrees so they can't stomp on each other.

### PR A — persist the silently-dropped agent settings

**Branch**: `feat/agent-settings-persistence` · **Risk**: Low · **Migration**: schema-additive

Today `packages/owletto-backend/src/lobu/stores/postgres-stores.ts` `rowToSettings()` and `saveSettings()` do not persist `egressConfig`, `preApprovedTools`, or `guardrails` — even though `packages/owletto-backend/src/gateway/config/file-loader.ts` produces them from `lobu.toml`. Cloud silently drops these fields. Without this fix, **`lobu apply` cannot achieve parity with local mode**.

Scope:
- Update `rowToSettings`/`saveSettings` to round-trip the three fields
- Schema column: extend the existing settings JSON column or add typed columns; pick whichever the surrounding code prefers
- Add unit tests covering round-trip
- No CLI changes

### PR B — org-scoped agent IDs

**Branch**: `feat/org-scoped-agent-ids` · **Risk**: High · **Migration**: yes, careful

Today `agent-routes.ts:getAgentOrganizationId` rejects any agent ID already used in another org. Two customers cannot both have `support`. `lobu apply` exposes this sharply because every customer's `lobu.toml` ships with a generic agent ID.

Scope:
- Make agent uniqueness `(org_id, agent_id)` not `(agent_id)`
- Update all FK joins, RLS policies, route param parsing
- Migration must handle existing data: rename collisions or assert "no collisions exist in prod" before the migration runs (count + report)
- Reconcile the agent-ID regex difference: local `^[a-z0-9][a-z0-9-]*$` vs cloud `^[a-z][a-z0-9-]{2,59}$`. Pick one (cloud's is stricter; align local to it).

**Caveat for the subagent**: this touches RLS and potentially every agent-scoped query. If the migration plan looks risky in the worktree, surface that loudly in the PR description and flag it as draft-needs-product-review rather than auto-merge.

### PR C — apply API + state substrate

**Branch**: `feat/apply-api` · **Risk**: High · **Migration**: yes, new tables

Scope:
- New table `applied_state` with columns: `org_id`, `resource_kind` (`'agent' | 'connection' | 'skill' | 'entity_type' | 'relationship_type'`), `resource_key` (e.g. `agent:support` or `connection:support-telegram-main`), `desired_hash`, `last_applied_hash`, `applied_at`, `applied_by_user_id`. Composite PK `(org_id, resource_kind, resource_key)`.
- New routes:
  - `POST /api/:orgSlug/apply/plan` — body: full desired-state document. Returns: per-resource `{ key, action: 'create'|'update'|'delete'|'drift'|'noop', diff, current_hash, desired_hash }`.
  - `POST /api/:orgSlug/apply` — body: same desired-state + plan token from `/plan`. Server re-validates plan token, acquires `pg_advisory_xact_lock` on `(org_id, resource_kind)`, applies in a single transaction, writes `applied_state` rows, returns per-resource result.
- **Idempotency**: same desired-state hash → `apply` is a no-op.
- **Drift detection**: live row hash vs `last_applied_hash`. If mismatch, plan returns `drift` action; apply requires `--force` (passed as a body flag).
- **Volatile field normalizer**: ignore `installedAt: Date.now()` and other server-injected timestamps when computing hashes.
- **Cloud-injected MCP server safeguard**: when an agent is auto-created by the cloud with an Owletto MCP server, the apply normalizer must reconcile that against the desired-state's `[memory.owletto]` block instead of treating it as drift on every plan.
- v1 resource handlers: `agent`, `skill`, `entity_type`, `relationship_type`. Connection handler stub returns "not implemented in v1, ship PR D" if the body includes connections.

### PR D — stable-id chat connection upsert

**Branch**: `feat/stable-id-connection-upsert` · **Risk**: Medium · **Migration**: maybe

Existing `POST /api/:orgSlug/agents/:agentId/connections` creates with a random ID, no update endpoint, list mixes runtime `chat_connections` with legacy `agent_connections`.

Scope:
- New endpoint `PUT /api/:orgSlug/agents/:agentId/connections/by-stable-id/:stableId` (or fold into apply's connection handler) that upserts using `buildStableConnectionId(agentId, type, name)` from `gateway/config/file-loader.ts:56` (already exists, deterministic).
- Reconcile `chat_connections` vs `agent_connections` for the upsert path so apply doesn't see split-brain rows.
- Plan must show "will restart connection" when a connection's config materially changes (bot drops in-flight messages on restart).
- Connection lifecycle: upsert sets desired state but does not auto-start; explicit `start`/`stop` stays separate (preserves the existing pause-bot-without-deleting flow).

### PR CLI — `lobu apply` end-to-end

**Branch**: `feat/lobu-apply-cli` · **Risk**: Medium

Scope:
- `packages/cli/src/commands/apply.ts`
- `packages/cli/src/commands/_lib/apply/`:
  - `desired-state.ts` — reuses `loadAgentConfigFromFiles` from `owletto-backend/src/gateway/config/file-loader.ts`. Adds memory schema reader. Walks `$VAR` refs and produces a list of required-secret names (does not resolve them).
  - `diff-renderer.ts` — pretty diff output with create/update/delete/drift markers, per-resource sections, color via chalk.
  - `apply-client.ts` — POSTs to `/api/:orgSlug/apply/plan` and `/api/:orgSlug/apply` with the bearer from `lobu login`.
  - `confirmation.ts` — TTY prompt; exit non-zero if not TTY and no `--force`.
- Wire into `packages/cli/src/index.ts` as a top-level command.
- Tests: snapshot tests for diff rendering, fake apply client, no real network.
- Docs: `packages/landing/src/content/docs/reference/lobu-apply.md`.

## Footguns to NOT copy from `seed-cmd.ts`

Pi flagged these — explicit do-not-copy list for the CLI agent:

1. Substring matching on `"already exists"` for conflict detection. Use structured HTTP status codes (`409` = conflict, `200` = success, etc.) and JSON error codes.
2. Watcher fallback to "first seeded entity" when the target is unresolvable. Apply must **never invent a target**; unresolvable refs = plan error.
3. Topological retry loop with bounded iteration count. Apply precomputes the dependency graph and fails fast if dependencies don't resolve.
4. Dry-run that mostly says "would create" — not a real diff. Apply's `--dry-run` must show the same per-resource `action` field that real apply uses.
5. Catching all errors with `console.error` and continuing. Apply must abort the transaction on the first error.
6. Treating HTTP 200 as success without checking `{ error }` payload. The MCP REST proxy returns `{ error }` with HTTP 200 for tool errors. CLI must inspect payload.
7. Casting parsed YAML to `Record<string, unknown>` without validation. Use Zod schemas (already exist in `packages/core/src/lobu-toml-schema.ts` for agent config; mirror for memory schema).
8. Mutating dry-run state with placeholder IDs that hide real backend validation failures.

## Testing strategy

### Per-PR

- A: unit tests for `rowToSettings`/`saveSettings` round-trip with all three new fields populated and empty
- B: migration test on a snapshot of prod-shaped data (or synthetic with collisions); RLS test with two orgs both holding `support`
- C: integration test against a local Postgres — `apply/plan` returns expected diff; `apply` is idempotent; drift is detected; transaction rolls back on a mid-batch failure
- D: connection upsert test — same stable ID, different config → update not duplicate; same config → noop
- CLI: snapshot tests for diff rendering; mock apply client

### End-to-end (this plan's exit criterion)

After all 5 PRs merge:
1. `make build-packages`
2. Spin up Postgres locally, run all migrations
3. Boot `lobu run` configured in **DB-first mode** (host-provided stores, not the file-first fallback) — same as Cloud's bootstrap
4. Run `lobu apply --dry-run` against a sample `lobu.toml` with at least one agent, one connection, one memory entity type, and one provider — verify diff is correct
5. Run `lobu apply` (no flags) — confirm prompt fires, accept, verify rows in Postgres match desired state
6. Run `lobu apply --dry-run` again — should report `noop` for everything
7. Edit `lobu.toml`, change one connection's config — re-run apply, verify only that connection shows update
8. Manually edit the connection in Postgres, re-run `lobu apply` — verify drift is detected
9. Run `lobu apply --force` — verify drift is overwritten

## Cross-cutting concerns

- **Provider credentials**: provider declarations live in the declared-agent registry, not in normal persisted Cloud settings. Apply pushing `installedProviders` alone does not guarantee the agent can call the provider. Document in v1 that user must set provider keys in cloud secrets before apply, same as the rest of the secrets story.
- **Runtime cache invalidation**: DB updates may not invalidate worker/grant caches the way file reload does. Apply needs to publish an invalidation event (existing pattern: PG NOTIFY?) or the worker needs to TTL the cache. Verify before close.
- **Prune blast radius**: `--prune` must exclude sandbox/system agents and only prune apply-managed resources. Resource handlers gate this via `managed_by = 'lobu-apply'` filter.
- **Connection restart side effects**: plan output must explicitly say "will restart connection X" so users aren't surprised by dropped in-flight messages.
- **Redacted values**: never diff `***1234` against desired config — apply normalizer must skip redacted values from the live read or use a `has_value` boolean only.

## Sequencing for the parallel rollout

```
                     ┌─────────────────┐
                     │  Plan doc       │  ◄── you are here
                     │  (this file)    │
                     └────────┬────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │        │        │        │        │
            ▼        ▼        ▼        ▼        ▼
          [A]      [B]      [C]      [D]      [CLI]
          low      high     high     med      med
          risk     risk     risk     risk     risk
            │        │        │        │        │
            └────────┴────────┼────────┴────────┘
                              ▼
                     ┌─────────────────┐
                     │ End-to-end test │
                     │ (this session)  │
                     └─────────────────┘
```

A, B, C, D, CLI run in parallel as draft PRs from worktree-isolated subagents. End-to-end test combines all five branches in a meta-worktree, runs the local Postgres + DB-first `lobu run` smoke flow above.

## Non-goals (for the avoidance of doubt)

- No `lobu pull` (v2)
- No raw `SKILL.md` round-trip (v2)
- No watchers in apply (v2)
- No secret value upload (v3)
- No memory data sync (v3)
- No multi-org parallel apply (single-org per invocation; org acquired via `--org` or `[memory.owletto].org`)
- No remote apply scheduler (apply runs synchronously, blocks until transaction commits)
