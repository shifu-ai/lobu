# DB-first platform: drop lobu.toml, collapse the second CLI

Supersedes `owletto-cli-merge.md` and `owletto-absorption.md` (CLI-side absorption parts).

## What & why

Postgres becomes the source of truth for everything declarative — agents, providers, skills, platforms, connectors, evals — replacing `lobu.toml`. Files become an **import/export format** consumed by `lobu seed` / `lobu export`. The `owletto` bin and `packages/owletto-cli` go away entirely; one CLI named `lobu`.

**Why this works now (and not earlier):** the `agents` table already holds `model`, `installed_providers`, `skills_config`, `network_config`, `mcp_servers`, `tools_config`, `agent_integrations`, and the prompt content (`soul_md`/`user_md`/`identity_md`). The toml is a façade over an already-DB-resident schema. Removing the toml is removing the façade, not building DB-first from scratch.

**Constraints:**
- No external users yet. Free to break.
- No backwards compatibility. Old code paths deleted in the same PR that introduces new ones.
- Self-hosted single-org is the target. Hosted multi-tenant hardening (RLS, RBAC, audit, lifecycle) is a separate later initiative — see "Out of scope" below.

## Final CLI surface

```
Usage: lobu [options] [command]

Agent runtime CLI

Options:
  -V, --version              output the version number
  -c, --context <name>       use a named context (default: active)
  --org <slug>               override active org for this command
  --json                     JSON output
  -h, --help                 display help for command

Server:
  run                        boot the embedded backend
  doctor                     health checks (system, DB, MCP, auth)

Identity & contexts:
  login [url]                authenticate (OAuth device flow)
  logout                     clear credentials
  whoami                     show identity, active context, active org
  context                    manage named contexts
  org                        manage orgs

Agent operations:
  chat <prompt>              send a prompt to an agent
  eval [name]                run evaluations
  agent                      manage agents

Configuration:
  provider                   manage LLM providers
  platform                   manage chat platforms (Slack, Telegram, ...)
  connector                  manage memory connectors (X, Google, ...)
  skill                      manage agent skills
  mcp                        MCP tool interaction (debug, configure clients)

Templates:
  seed                       import a template into the active org
  export                     export the active org as a portable template
```

### Subcommand surfaces

```
lobu org           list | create <slug> | show <slug> | use <slug> | current | delete <slug>
lobu agent         list | create | show <slug> | update <slug> | delete <slug>
lobu provider      list | add <id> | show <id> | delete <id>
lobu platform      list | add <type> | show <id> | remove <id>
lobu connector     list | add <key> | auth <key> | show <key> | remove <key>
lobu skill         list | install <id> | show <id> | remove <id>
lobu context       list | use <name> | add <name> | current | remove <name>
lobu mcp           call <tool> [json] | list | endpoint | configure <client>
```

## What's gone

| Removed | Why |
|---|---|
| `lobu init` | No toml to scaffold |
| `lobu validate` | DB schema enforces; no client-side file to validate |
| `lobu secrets` | `.env` edited directly like `gitlab.rb` |
| `lobu status` | Folded into `lobu doctor` |
| `lobu memory <verb>` | No separate memory subsystem; folded into top-level + `mcp` |
| `lobu run --memory-only` | `lobu run` boots the full embedded stack |
| `owletto` bin | Package deleted entirely |
| `packages/owletto-cli/runtime/` | Standalone runtime path gone with `owletto start` |
| `[memory.owletto]` toml namespace | No toml |
| Skill bundle split | Merged into `packages/cli/bundled-skills/` |

## Phase 1 — Schema gap fill + API completeness

**Estimate:** 3-5 days. **Purely additive.** Toml path untouched. Lands first; subsequent phases depend on this.

### Audit deliverable

Field-by-field map of `packages/core/src/lobu-toml-schema.ts` → DB column / endpoint. Documented in this plan as a table once complete. Expected gaps:

| `lobu.toml` field | DB equivalent | Status |
|---|---|---|
| `[agents.X]` name/description | `agents.name`, `agents.description` | ✓ |
| `[agents.X].dir` (system prompt) | `agents.soul_md` (likely) | ✓ |
| `[[agents.X.providers]]` | `agents.installed_providers` jsonb | confirm CRUD |
| `[agents.X.skills.mcp.<id>]` | `agents.mcp_servers` jsonb | confirm CRUD |
| `[agents.X.network]` | `agents.network_config` jsonb | ✓ |
| `[agents.X.egress]` | `agents.network_config` (judge subkey) | confirm |
| `[agents.X.tools].pre_approved` | `agent_grants` table | confirm CRUD |
| `[agents.X.guardrails]` | `agents.tools_config` (likely) | confirm |
| `[[agents.X.connections]]` | `connections` table | ✓, verify CRUD |
| `[memory.owletto]` org/name | `organization` + `workspace_settings` | ✓ |
| `[memory.owletto].models` | `entity_types` table | ✓ |
| `[memory.owletto].data` | `entities` + `events` | seed-only |
| Evals (`evals/*.yaml`) | **stay as files** — dev artifact, not runtime state. Like `.gitlab-ci.yml`. |

### Audit findings (completed)

**Existing endpoints — usable as-is:**

| Surface | Path | Notes |
|---|---|---|
| Internal admin (`mcpAuth`) | `GET/POST /api/agents`, `PATCH/DELETE /api/agents/:id`, `GET/PATCH /api/agents/:id/config`, `GET/POST/DELETE /api/agents/:id/connections[/:connId]` | covers admin UI's needs |
| Public OpenAPI (`/api/v1`) | `POST /api/v1/agents`, `GET/DELETE /api/v1/agents/:id`, `GET /api/v1/agents/:id/events`, **`POST /api/v1/agents/:id/messages`** | `messages` is what `lobu chat` and `lobu eval` will hit |
| Catalogs | `GET /api/agents/:id/config/providers/catalog`, `GET /api/agents/:id/config/skills/catalog`, `GET /api/agents/config/skills/catalog` | already exposed; promote provider catalog to top-level |

`PATCH /api/agents/:agentId/config` already accepts arbitrary settings updates — covers `installed_providers`, `skills_config`, `mcp_servers`, `network_config`, `tools_config`, `nix_config`, `soul_md`/`user_md`/`identity_md` jsonb fields. No new field-level endpoints needed.

**Field-by-field map (toml → DB):**

| `lobu.toml` | DB column / surface | Status |
|---|---|---|
| `agents.X.name` / `description` | `agents.name` / `agents.description` | ✓ |
| `agents.X.dir` (prompt path) | `agents.soul_md` (content) | ✓ |
| `agents.X.providers` | `agents.installed_providers` jsonb | ✓ via PATCH /config |
| `agents.X.skills.mcp` | `agents.mcp_servers` jsonb | ✓ via PATCH /config |
| `agents.X.network` | `agents.network_config` jsonb | ✓ via PATCH /config |
| `agents.X.egress` | `agents.network_config.judge*` | ✓ |
| `agents.X.tools.pre_approved` | `agent_grants` table | ✓ table exists; **CRUD endpoint missing** |
| `agents.X.tools.allowed/denied/strict` | `agents.tools_config` jsonb | ✓ via PATCH /config |
| `agents.X.guardrails` | `agents.tools_config` (likely) | confirm in implementation |
| `agents.X.connections` | `connections` table + nested route | ✓ |
| `agents.X.worker.nix_packages` | `agents.nix_config` jsonb | ✓ via PATCH /config |
| `memory.owletto.*` | `organization` + `workspace_settings` | ✓ |
| `memory.owletto.models` (entity types) | `entity_types` table | ✓ |
| `memory.owletto.data` (seed entities) | `entities` + `events` | seed-only, file-driven |
| Evals | files only | file-based, no DB |

### Gaps to close in Phase 1

Scoped to **only what `lobu seed` needs to write into the DB.** UX endpoints (top-level catalogs) deferred to Phase 3 when we know exactly what the CLI calls.

1. **Add `guardrails` column to `agents`.** No persistence today — toml-only. Migration + read/write wire-up across both stores. **DONE.**
2. **Add `skills` table.** Per-org skill rows so hosted lobu.ai can serve different skill sets per org without a binary release. Schema below.
3. **`agent_grants` HTTP CRUD.** Table + store methods exist (`packages/owletto-backend/src/lobu/stores/postgres-stores.ts:660`); no HTTP route. Add `GET/POST/DELETE /api/{org}/agents/:agentId/grants`. Needed for `seed` to import `pre_approved` MCP tool patterns.
4. **Connector HTTP CRUD.** `connector_definitions` + `connector_versions` tables exist; no HTTP routes found. Add CRUD for `/api/{org}/connectors` + `/api/{org}/connectors/:key/versions`. Needed for `seed` to import `connectors/<key>/` directories from templates.
5. **Org HTTP CRUD.** Today orgs are created implicitly via auth flows. Add `GET/POST/DELETE /api/orgs` for `lobu org` and for `seed --org <slug>` to create-if-missing.
6. **Per-org isolation tests** for new endpoint groups. Mirror the pattern in `packages/owletto-backend/src/__tests__/integration/`.

Skills table schema:

```sql
CREATE TABLE skills (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  slug text NOT NULL,            -- "lobu", "owletto-openclaw", "custom-skill"
  content text NOT NULL,          -- raw SKILL.md markdown
  manifest jsonb NOT NULL,        -- frontmatter (mcp_servers, network, nix_packages)
  source text,                    -- "bundled:lobu" or "uploaded" or "template:sales"
  bundled_version text,           -- @lobu/cli version copied from (null if uploaded)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
```

Skill CRUD endpoints come in Phase 3 with the rest of the CLI wiring; the table goes in now to lock the schema.

### Deferred to Phase 3 (when wiring the CLI)

- Promoting provider catalog to top-level `/api/{org}/providers/catalog`
- Top-level skill catalog at `/api/{org}/skills/catalog`
- Skill CRUD HTTP endpoints (`/api/{org}/skills`)

These are read-only or CLI-tied endpoints. The CLI's exact needs become clear in Phase 3; deciding their final shape now would be premature.

**Total schema across all 4 phases: 1 new column (`agents.guardrails`) + 1 new table (`skills`).** Everything else is exposing existing storage.

**Phase 1 estimate: 2 days.**

### Validation

- `bun test packages/owletto-backend` clean
- `bun run typecheck` clean
- New endpoints documented via existing OpenAPI generator
- Toml path still works end-to-end (Phase 1 is additive)

## Phase 2 — Boot path migration (1-1.5 weeks)

*[detailed scope to be written before this phase begins; placeholder structure]*

- Replace `loadConfig(cwd)` → DB queries everywhere
- Empty-DB → default-org creation logic; admin token bootstrap (env var for prod, stdout for dev)
- Delete `packages/owletto-backend/src/gateway/config/file-loader.ts` and the toml zod schema
- Delete `LOBU_DEV_PROJECT_PATH` plumbing
- Delete `packages/core/src/lobu-toml-schema.ts`
- After this PR, `lobu run` reads only from DB. Toml file is silently ignored or errors with a migration hint.

## Phase 3 — CLI rewrite + owletto bin removal + templates (1.5-2 weeks)

*[detailed scope to be written before this phase begins; placeholder structure]*

- Drop `lobu init`, `lobu validate`, `lobu secrets`, `lobu memory <verb>` namespace
- Add the new commands per the surface above
- Active org context (`~/.lobu/contexts.json`); `--org` override on every client command
- Delete `packages/owletto-cli` and `packages/owletto-cli/runtime/`
- Merge bundled skill stores into `packages/cli/bundled-skills/`
- Define template format:
  ```
  template-<name>/
    manifest.json              — template name, version, target lobu schema
    agents/<slug>/
      agent.json               — model, network_config, mcp_servers, tools refs
      system.md                — prompt content (→ agents.soul_md)
    providers.json             — org-level LLM providers
    platforms.json             — chat platforms (Slack, Telegram, ...) with $ENV refs
    connectors/<key>/          — directory because connectors carry code + assets
      connector.json           — manifest (config schema, cookie domains, version)
      definition.js            — sandbox code (→ connector_versions row)
      icon.svg                 — optional
    skills/<id>/                — optional org-local skill bundles (rare)
    models/*.yaml              — entity type schemas
    data/*.yaml                — seed entities (opt-in)
    evals/*.yaml               — developer-managed, stay file-based at runtime
  ```
- Implement `lobu seed --from <dir>` (idempotent reconcile, hardcoded scope = declarative tables only, secret-preserving by default, `--dry-run`, `--reset`, `--reset-data`, `--rotate-secrets`)
- Implement `lobu export --to <dir>` with stable natural keys and secret redaction (refs only, never values)
- Convert 12 `examples/*` → `templates/*`

## Phase 4 — Tests + docs sweep (1 week)

*[detailed scope to be written before this phase begins; placeholder structure]*

- Migrate 176 test files: per-test org isolation, fixture seeding via API
- Snapshot tests for `lobu export` determinism
- Empty-DB-bootstrap tests
- README, landing site, blog posts, RELEASING.md, CI yml
- Rename landing's `reference/owletto-cli.md` → `reference/lobu.md`
- Drop `[memory.owletto]` references everywhere
- Skill metadata updates (the `owletto` Claude Code skill etc.)

## Hard rules across all phases

1. **`lobu seed` only touches declarative tables.** Hardcoded list:
   `agents`, `agent_grants`, `agent_connections`, `agent_channel_bindings`, `connections`, `entity_types`, `entity_relationship_types`, `watchers`, `evals`, plus jsonb fields on `agents`. Never touches `events`, `entities` (except via explicit `--reset-data`), `runs`, `oauth_*`, `auth_profiles`, `personal_access_tokens`, or any runtime-state table.
2. **Append-only events are never deleted.** `events` is append-only; tombstone/supersede only. `lobu seed` cannot reach the events table.
3. **Secrets preserved across reconcile by default.** Connection rows matched by stable key (`org_id, agent_id, type, slug`) keep their `oauth_token`, `secret_ref`, runtime credentials when reconciled. `--rotate-secrets` is the explicit override.
4. **Export is deterministic.** Stable natural keys (org slug, agent slug, provider id, skill slug, platform slug). DB-generated UUIDs and timestamps excluded from export. Secrets redacted to `$ENV_REF` placeholders, never values.
5. **`.env` is server-process config**, like `gitlab.rb`. Edited directly. Not managed via CLI.

## Out of scope (future plans)

These are real concerns surfaced by `pi` critique but apply to hosted multi-tenant lobu, not self-hosted single-org. Tracked for a separate hosted-platform initiative:

- Multi-tenant isolation hardening: RLS on high-risk tables (events, secrets, oauth_tokens), tenant-aware data access layer audit, side-channel sweep (workers, filesystem workspaces, vector search, MCP sessions, webhooks)
- RBAC: org membership model, role/permission matrix
- Org lifecycle: transfer ownership, delete org, suspend org, OAuth revoke, force-reload workers on org access changes
- Production-grade admin bootstrap: env-var-driven, no token in logs (today: dev prints to stdout)
- Audit log
- Skill versioning (`content_hash` column on skills, recorded per run for eval reproducibility)
- Backup/restore tooling beyond `pg_dump`
- Remote template fetching (`lobu seed --from github.com/...`, `lobu seed --from @lobu/template-sales`)
- Renaming `packages/owletto-*` directories and `@lobu/owletto-*` package names — provenance prefix stays for now
- Internal data model rename: `chat_connections` → `channels` was considered and reverted (collision with existing `channelId` per-chat semantic)

## Sequencing notes

- **Each phase ships as its own PR** stacked on `feat/db-first-platform`.
- **Phase 1** is purely additive; can land independently and unblock real-world testing of the new endpoints.
- **Phase 2** depends on Phase 1; swaps boot from toml to DB. After Phase 2 lands, the toml is functionally dead but the CLI still pretends it exists.
- **Phase 3** is the user-facing breakage; cuts `init`/`validate`/`secrets`, drops `owletto` bin.
- **Phase 4** is mechanical cleanup.
- **Total: 3-4 weeks** of focused work.

## Branch + worktree

- Worktree: `/Users/burakemre/Code/lobu-db-first/`
- Branch: `feat/db-first-platform` (off `main`)
- PRs target `main` directly; each phase ships its own PR cherry-picked or rebased off this branch.
