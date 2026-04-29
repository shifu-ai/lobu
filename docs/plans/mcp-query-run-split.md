# MCP `query` / `run` split: read-only scripting + memory-first surface

Successor to `docs/plans/mcp-multi-org-and-execute.md`. That plan landed `execute` + `search` + `client.org(...)`. This plan splits `execute` into a read-only `query` tool and a write `run` tool, curates a read-only SDK surface, locks down the cross-org boundary on scoped endpoints, and tightens the memory hot path so hosts auto-approve `save_knowledge`.

Target repo: `packages/owletto-backend`, with a light frontend follow-up in `packages/owletto-web` (tool-call card label for `run`/`query`). **`packages/cli` is unchanged** — it talks to Owletto over REST/session and does not depend on the public MCP tool names.

## Owletto is a memory system. Everything else is secondary.

The thing an MCP client (ChatGPT, Claude Code, Cursor) does against Owletto on the hot path is **read and write user memory**. Power tools (watchers, connections, schemas, classifiers) exist for setup and automation but are reached rarely. Tool order, annotations, and descriptions all reinforce this hierarchy:

1. **Memory hot path — every turn.** `search_knowledge`, `save_knowledge`.
2. **Discovery — a few times per session.** `list_organizations`, `search`.
3. **Power tools — rarely.** `query`, `run`, `query_sql`.

If a change makes memory harder to reach, it's wrong.

## Endpoint behavior: the token's bound org is the default

Every OAuth and PAT token in Owletto is **bound to exactly one organization** at issuance. The OAuth consent flow asks the user to pick an org (`orgSelectionRequired` in `packages/owletto-backend/src/auth/oauth/routes.ts:112`); PATs are minted bound to an org. There is no "profile default," no "last-pinned" session state, no cross-org token. **The token IS the binding.**

Both URL endpoints expose the same tool list. The URL controls the cross-org affordance, the auth method controls whether cross-org hops can re-validate.

| Auth | URL | Default org | `client.org(other)` |
| --- | --- | --- | --- |
| OAuth / session | `/mcp` | the token's bound org | ✅ re-validates user membership in `other` against the `member` table |
| OAuth / session | `/mcp/{slug}` | slug must equal token's bound org, else **403** | ❌ scoped boundary, throws `CrossOrgAccessDenied` |
| PAT | `/mcp` | the PAT's bound org | ❌ PAT carries no full user identity — cannot re-validate other memberships |
| PAT | `/mcp/{slug}` | slug must equal PAT's bound org, else **403** | ❌ |

**Why PATs can't cross-org.** A PAT represents "the user, acting as a member of org X." It does not carry full user identity beyond that binding, so the server cannot re-validate membership in a different org from the PAT alone. Granting cross-org access to a PAT would mean the token leaks beyond its intended scope. OAuth/session credentials carry user identity, so `client.org(other)` can re-validate against the `member` table per hop.

**Why both URL forms exist.** `/mcp` declares "I want the cross-org affordance for this connection" (only meaningful with OAuth). `/mcp/{slug}` declares "this connection is workspace-isolated regardless of what the token could do." Same token capability, different connection-time stance.

There is no "no-org" mode for memory tools. They always run against *some* org — the token's bound org by default, or explicitly via `client.org(...)` on OAuth+`/mcp`.

## Append-only contract: storage immutable, default view filtered

Two distinct concerns that must not be conflated:

- **Storage layer:** the `events` table is *physically immutable*. Rows are never deleted or mutated. Even GDPR / privacy-erasure flows append a tombstone event rather than removing a row. Hard delete does not exist on the public MCP surface and does not exist on the public REST/session surface either; if it ever exists, it is admin-only platform tooling outside the scope of any agent-facing API.
- **Default read view:** `search_knowledge`, `client.knowledge.search`, and `query_sql` (against the canonical view) hide events that have been **superseded** (a newer event in the chain points at them via `supersedes_event_id`) or **withdrawn** (a status event marks them invalid). The agent and end-user see only the current state.

History is not exposed to the agent surface. There is no `include_history` flag on `search_knowledge`, no `client.knowledge.history()` in the SDK. History walks happen via REST/session admin tools or owletto-web's UI, never via MCP.

**Implication for `save_knowledge` annotations:** because storage is append-only and the prior state is fully preserved, `save_knowledge` is annotated `readOnlyHint: true`. Hosts auto-approve it. This is technically a stretch of the MCP spec ("read-only" canonically means "doesn't modify state") but defensible for an append-only event log: no information is destroyed, only the current view changes. The hot path stays frictionless.

**Implication for `run`:** `client.knowledge` exposes `save`, `search`, `get` — no `delete`, no history. Forgetting a fact means appending a `supersedes` or `withdrawn` event via `save_knowledge` or `client.knowledge.save(...)`, never removing one.

## Surface after this plan

Tools listed in the order an agent meets them — memory first, power tools last.

| Tool | Annotation | Replaces / new | Notes |
| --- | --- | --- | --- |
| `search_knowledge` | `readOnlyHint: true, idempotentHint: true` | annotation added | **Memory hot path: read.** First stop for any user question. |
| `save_knowledge` | `readOnlyHint: true` | annotation changed (was default) | **Memory hot path: write.** Append-only at storage; superseded/withdrawn events hide from default view. Defensible as read-only-hint. |
| `list_organizations` | `readOnlyHint: true, idempotentHint: true` | annotation added | Bootstrapping. Response marks the current and default org. |
| `search` | `readOnlyHint: true, idempotentHint: true` | unchanged | SDK introspection. |
| `query` | `readOnlyHint: true, idempotentHint: true` | new | TS script over a read-only SDK. Auto-approves. |
| `query_sql` | `readOnlyHint: true, idempotentHint: true` | optional `org_slug` on `/mcp` | Read-only SQL. On unscoped, accepts `org_slug` for cross-org reads. |
| `run` | `destructiveHint: true` | renamed from `execute` | TS script over the full SDK. Setup, automation. |
| `manage_connections` | n/a | now `internal: true` | Folded into `run` for writes; CLI keeps using it via REST/session. |
| `manage_auth_profiles` | n/a | now `internal: true` | Same. |
| `resolve_path` | `internal: true, readOnlyHint: true` | unchanged | Frontend only. |

Public-facing tool count: **7** (`search_knowledge`, `save_knowledge`, `list_organizations`, `search`, `query`, `query_sql`, `run`). Net change vs today: **+1** (`query`), one rename, two demotions to internal.

## Key decisions

### D1. Two tools, not a `mode` parameter on one

MCP host UIs read `readOnlyHint` *before* the call to decide whether to auto-approve. A runtime parameter cannot drive that. The split must live at the tool-list level.

### D2. Naming: `query` and `run`

- `query` reads as non-mutating in every SDK / SQL / GraphQL / ORM mental model.
- `run` is short, generic enough to cover side effects, and pairs with `query`.
- Rejected: `read` / `write` (too generic), `eval` (overloaded, scary), `execute` (current — competes with every other MCP server's `execute`, no hint that it's a TS sandbox).
- No alias period. Per repo policy ("No backwards-compatibility shims"), `execute` is dropped in the same release. CHANGELOG flags the rename.

### D3. Read-only SDK driven by `METHOD_METADATA`, with proper Proxy traps

`packages/owletto-backend/src/sandbox/method-metadata.ts` already tags every SDK method with `access: "read" | "write" | "external"` (verified — used today by `search` for dry-run classification). The read-only SDK is just a filter on this metadata: **expose only methods where `METHOD_METADATA[dotted_path].access === "read"`.** No hand-maintained allowlist.

```ts
buildClientSDK(ctx, env, { mode: "read", allowCrossOrg: false });
```

This means:
- New SDK methods automatically inherit the right behavior based on their metadata `access` field. Add a method without metadata → it doesn't appear in the read-only SDK (and a coverage test catches the missing metadata entry).
- The "allowlist" lives in one place (the metadata table) instead of scattered across namespace builders.

**Absence is the contract — and must be enforced at the Proxy level.** Today's guest SDK is a Proxy that returns a callable function for any property access. That means `typeof client.entities.delete === "function"` even if the method is "missing" — absence only surfaces on call. To make `typeof client.entities.delete === "undefined"` true inside the isolate, the guest proxy must implement `get`, `has`, and `ownKeys` traps that consult an injected manifest of allowed dotted paths. Tests assert the `typeof` and `'delete' in client.entities` semantics, not just "the call throws."

**Capability propagation rules:**

- `client.org(slug)` returns another SDK with the *same* `mode` and `allowCrossOrg` carried through. Never a generic full-mode SDK from a read-only handle.
- On scoped endpoints OR on PAT auth, `client.org(other)` throws `CrossOrgAccessDenied`.
- The read-only SDK never holds a reference to the full SDK builder. They are separate objects.
- Exposed namespace objects are deep-frozen before injection into the isolate. Scripts cannot reassign methods.
- Inputs and outputs cross the isolate boundary via structured-clone (already true). No function references survive the boundary.
- `Function`, `eval`, dynamic `import`, `require`, `process`, top-level `fetch` are unreachable inside the isolate (already enforced by `isolated-vm`).
- The script's `client.knowledge` namespace in the *full* SDK exposes `search`, `save`, `read` — no `delete`, no history. (Note: actual SDK method name is `knowledge.read`, not `get`.)
- The script's `client.organizations` exposes `list`, `current` (read methods per `METHOD_METADATA`).

### D4. Sandbox stays single

`runScript` already takes the SDK as a parameter. `query` calls it with the read-only SDK; `run` calls it with the full SDK. Same isolate runtime, same compile path. Tool-name-on-span is the only telemetry difference.

### D5. Output size cap + cancellable SDK calls

- Return values are capped at **1 MB** of serialized JSON, measured via `Buffer.byteLength` (not string length — multibyte characters matter). Over the cap, the runtime returns a structured error telling the script to paginate or filter. Input cap stays at 100k chars (current).
- Per pi review: isolated-vm's wall-clock timeout cancels the script but does **not** cancel an in-flight host-side SDK call (DB query, external HTTP). To make timeouts effective, every SDK dispatch threads an `AbortSignal` from `runScript`'s timeout into the underlying handler. This is a Phase 1 deliverable, not optional. Without it, a malicious or buggy script that triggers a slow upstream query hangs host resources past the timeout.

### D6. Watcher reactions always run `mode: "full"`

Reactions are server-side automation already approved by the user when they created the watcher. Implicit trust is higher than an MCP tool call. Reactions that don't need to write simply don't call write methods; they don't need the SDK to refuse them.

### D7. Documentation: stay minimal, no new subsystem

Three layers, ordered by token cost. None of them are a new docs subsystem.

1. **Tool description** — short (under ~250 chars), each scripting tool includes a 3-line example. Always loaded.
2. **MCP `initialize` preamble** — the existing "## Owletto — Your Persistent Memory" block. Stays as-is, with one wording pass to reflect `query` / `run` instead of `execute`. Always loaded by hosts on connect.
3. **`search` results** — already returns SDK signatures. Add a `usage_example` field on the **~10 highest-traffic methods** (`entities.list/get/find`, `watchers.list/create`, `knowledge.search/save`, `client.query`, `client.org`). Loaded on demand, only when the agent calls `search`.

**Explicitly not adding**: `mcp://owletto/docs/*` resources, a `packages/owletto-backend/src/docs/` markdown directory, a resource registry, `resources/list` / `resources/read` handlers. The plan considered them and rejected them — the preamble + tool descriptions + `search` cover what agents actually need. Revisit only if a concrete gap shows up after rollout.

### D8. Sentry observability

- Both tools log `MCP Tool Call: query` / `MCP Tool Call: run` spans (existing pattern in `packages/owletto-backend/src/sentry.ts`).
- Script source is captured on both spans (existing sanitizer redacts sensitive fields).
- `ReadOnlySDKViolation` raised when a script attempts a method missing from the read-only allowlist — surfaces to the agent (so it can retry with `run`) and to Sentry.
- No persistent audit log for cross-org access in this plan. If/when an org admin asks "who accessed my workspace cross-org," that becomes a follow-up plan with a real `audit_events` table. Sentry breadcrumbs are sufficient for engineering observability today.

## Implementation phases

**Ordering rationale (per pi review).** MCP clients aggressively cache `tools/list`. Shipping a half-renamed surface (e.g. `query` registered while descriptions still reference `execute`) would surface mid-rename state to clients. So the rename, the new `query` tool, the annotations, and the description rewrites all land in the **same deploy** even if structured as separate phases. Auth/context plumbing comes first; everything else follows.

### Phase 0 — Auth context plumbing

Verify and (where missing) extend `ToolContext` with the fields downstream phases need:
- `tokenType: "oauth" | "session" | "pat" | "anonymous"` — drives PAT-specific branches in `query_sql` and the cross-org gate.
- `scopedToOrg: boolean` — already present per `mcp-handler.ts:277`. Confirm it propagates into `executeTool`.
- `allowCrossOrg: boolean` — new. Computed by mcp-handler at session start: `tokenType === "oauth" && !scopedToOrg`. Threaded through `buildClientSDK`.
- **Null-org-token policy.** OAuth/PAT records today permit `organization_id: null` (legacy). For this plan, sessions that arrive with no bound org are rejected at connect time with a clear error: "this token has no organization binding; please re-authenticate." No silent fallback. Migration audit (count of legacy null-org tokens) goes into the PR description; if the count is non-trivial, add a one-off backfill or grace path before merge.
- Tests: extending `tools-list.test.ts` to assert auth-context shape on each token type.

### Phase 1 — Read-only SDK builder + cross-org gate

- `packages/owletto-backend/src/sandbox/client-sdk.ts` — extend `buildClientSDK(ctx, env, opts?: { mode?: "read" | "full"; allowCrossOrg?: boolean })`. `mode` defaults to `"full"` (so watcher reactions are unaffected). `allowCrossOrg` is set by the caller (mcp-handler) based on Phase 0's auth context.
- `packages/owletto-backend/src/sandbox/namespaces/*.ts` — each namespace builder filters its method record by `METHOD_METADATA[dotted_path].access === "read"` when `mode === "read"`. No hand-maintained allowlist. Coverage test asserts every method exported by every namespace has a `METHOD_METADATA` entry.
- **Guest Proxy traps.** Update `run-script.ts`'s guest-side proxy to consult an injected manifest of allowed dotted paths. Implement `get` (returns `undefined` for absent methods), `has` (returns `false`), and `ownKeys` (returns only present methods). Goal: inside the script, `typeof client.entities.delete === "undefined"` and `'delete' in client.entities === false`.
- `client.org(slug)` returns a new SDK carrying the same `mode` and `allowCrossOrg`; throws `CrossOrgAccessDenied` when `allowCrossOrg === false`.
- **AbortSignal threading.** Every namespace's host-side dispatcher accepts an `AbortSignal` from `runScript`. When the script's wall-clock timeout fires, in-flight DB/HTTP calls cancel rather than continuing past the timeout.
- `packages/owletto-backend/src/sandbox/run-script.ts` — enforce 1 MB output cap measured via `Buffer.byteLength`. Over cap → structured error.
- `packages/owletto-backend/src/sandbox/__tests__/read-only.test.ts` — new. Cases: `typeof client.entities.delete === "undefined"` inside the script (not just throws); `client.entities.list()` works; `client.org(...).entities.delete(id)` unreachable; `client.knowledge.read()` works (note: method name is `read`, not `get`); deep-freeze prevents method reassignment; coverage test enumerates every namespace key against `METHOD_METADATA`.
- `packages/owletto-backend/src/sandbox/__tests__/cross-org-gate.test.ts` — new. Cases: OAuth on `/mcp/{slug}` + `client.org(other)` throws; OAuth on `/mcp` + `client.org(other)` works for member; PAT on `/mcp` + `client.org(other)` throws; PAT on `/mcp/{wrong-slug}` → 403 at connect time; chained `org(a).org(b)` carries `mode` and `allowCrossOrg`.
- `packages/owletto-backend/src/sandbox/__tests__/abort.test.ts` — new. Cases: a script whose SDK call exceeds the timeout sees the call abort; the upstream handler observes `AbortSignal.aborted === true`.
- Watcher reactions in `packages/owletto-backend/src/watchers/*` continue to call `buildClientSDK(ctx, env)` with default `mode: "full"`. No change. One regression test asserts reactions are unaffected.

### Phase 2 — Rename `execute` → `run` (lands before `query` registration)

- `packages/owletto-backend/src/tools/sdk_execute.ts` → `sdk_run.ts`. Rename `executeScript` symbol (watch for collision with `sandbox/run-script.ts`).
- `packages/owletto-backend/src/tools/registry.ts` — change name field. Drop the historical "Replaces the previous `manage_*` MCP tool surface" line from the description.
- `rg -F "'execute'" packages/` to find tool-name string references; update.
- `docs/plans/mcp-multi-org-and-execute.md` — append a one-liner: "Superseded for tool naming + read-only split by `mcp-query-run-split.md`."

### Phase 3 — `query` tool registration

- `packages/owletto-backend/src/tools/sdk_query.ts` — new file mirroring `sdk_run.ts`. Calls `runScript` with the read-only SDK.
- `packages/owletto-backend/src/tools/registry.ts` — add `query` entry adjacent to `search` and `run`. Annotation: `{ readOnlyHint: true, idempotentHint: true }`.
- `packages/owletto-backend/src/auth/tool-access.ts` — `query` requires `read` access; `run` keeps `write`.
- `packages/owletto-backend/src/__tests__/integration/mcp-query.test.ts` — end-to-end: list tools shows `query` with correct annotations; reads succeed; attempted writes fail because the methods are absent from the SDK, not because the call throws.

### Phase 4 — Annotations

- `packages/owletto-backend/src/tools/registry.ts` annotation pass:
  - `search_knowledge`: `{ readOnlyHint: true, idempotentHint: true }`
  - `save_knowledge`: `{ readOnlyHint: true }` — append-only justifies it; idempotent only when `supersedes_event_id` is passed (so don't claim it).
  - `list_organizations`: `{ readOnlyHint: true, idempotentHint: true }`
  - `search`: confirm `{ readOnlyHint: true, idempotentHint: true }`
  - `query_sql`: confirm `{ readOnlyHint: true, idempotentHint: true }`
  - `query`: `{ readOnlyHint: true, idempotentHint: true }`
  - `run`: `{ destructiveHint: true }`
- `packages/owletto-backend/src/__tests__/integration/tools-list.test.ts` — assert the matrix above.

### Phase 5 — `list_organizations` marks the bound org

- `packages/owletto-backend/src/tools/organizations.ts` — extend response: each org includes `is_current: boolean`, true for the token's bound org. There is no separate `is_default` since the bound org *is* the default. The agent uses `is_current` to know "which org are my memory tools targeting right now."
- Test: existing integration test extended.

### Phase 6 — `query_sql` accepts optional `org_slug` on unscoped only

- `packages/owletto-backend/src/tools/admin/query_sql.ts` — add optional `org_slug` parameter.
- Routing: on `/mcp/{slug}` connections, `org_slug` is **rejected** (`InvalidArgument` — scoped endpoints don't allow cross-org SQL). On `/mcp` (OAuth/session only), `org_slug` redirects SQL at any org the user is a member of; PAT connections reject `org_slug` since PATs can't prove cross-org membership.
- Test: SQL with `org_slug` on scoped endpoint → error; on unscoped + OAuth → works for member orgs, fails for non-member; on unscoped + PAT → error.

### Phase 7 — Tool descriptions + `search` usage examples

- `packages/owletto-backend/src/tools/registry.ts` — description rewrites:
  - `search_knowledge`: lead with "**First step** when answering anything about the user." Tighten to <250 chars.
  - `save_knowledge`: lead with "Save user-shared facts, preferences, decisions, observations." Note that storage is append-only.
  - `query`: state the `(ctx, client)` contract, include a 3-line example, cross-reference `search` for method discovery, note the 1 MB output cap.
  - `run`: same as `query`, plus "destructive — confirm before running" framing.
  - `query_sql`: short. Note `org_slug` is unscoped + OAuth only.
- `packages/owletto-backend/src/sandbox/method-metadata.ts` — extend metadata with optional `usageExample: string`.
- `packages/owletto-backend/src/sandbox/namespaces/*.ts` — backfill `usageExample` for the ~10 hot-path methods (entities.list/get/find, watchers.list/create, knowledge.search/save, client.query, client.org).
- `packages/owletto-backend/src/tools/sdk_search.ts` — surface `usage_example` in `search` response when present.

### Phase 8 — Preamble wording pass

- The existing MCP `initialize` instructions block ("## Owletto — Your Persistent Memory") is updated in-place to reference `query` / `run` instead of `execute`. No structural change. Stays inline as a string — no new docs directory.

### Phase 9 — Frontend (owletto-web): no change required

Verified: `packages/owletto-web/src/` has zero tool-name pattern matchers on `'execute'` (only references are a UI copy string in `event-card.tsx:373` and an unrelated `action: 'execute'` payload in `connections.ts:517`). Tool names flow through to the call cards verbatim, so the rename surfaces automatically without any submodule change.

No submodule PR. No parent bump. If a future tool-call card wants special treatment for `query` / `run`, it goes in a separate concern.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Read-only SDK leaks write access via a missed mutator | Allowlist not denylist (D3). New methods unreachable until explicitly added. Test enumerates every namespace. |
| `save_knowledge` annotated `readOnlyHint: true` is interpreted strictly by some host | The append-only storage justifies the claim. If a host refuses to render it as a "modification" we rely on the audit log + owletto-web for visibility. Acceptable. |
| Renaming `execute` breaks external MCP clients | Surface is small, pre-1.0. CHANGELOG flags it as breaking. No alias period. |
| `query` and `run` confused at call time by the agent | Cross-references in tool descriptions; `ReadOnlySDKViolation` from `query` tells the agent to retry with `run`. |
| PAT on `/mcp` confused with OAuth cross-org behavior | Connect-time error message is explicit: PATs on `/mcp` behave as if scoped to the PAT's org. Tool list does not include cross-org affordances when auth is PAT. |
| 1 MB output cap surprises agents | Structured error with a "paginate or filter" hint surfaces directly to the script's exception path. |
| Method-level access checks regress because `query` looks like a free pass | `query` still calls per-method `checkToolAccess` inside the SDK. The read-only allowlist is *capability* gating on top of, not a replacement for, role-based access. |

## Acceptance checklist

- [ ] `search_knowledge` and `save_knowledge` lead the tool list with memory-first descriptions; both `readOnlyHint: true`.
- [ ] `query` present in `tools/list` for both endpoints with `readOnlyHint: true`.
- [ ] `run` present (replacing `execute`) with `destructiveHint: true`.
- [ ] `manage_connections` and `manage_auth_profiles` no longer appear in external `tools/list`; CLI's REST/session calls still work.
- [ ] Read-only SDK: every mutator method is `undefined` on its namespace; new test enumerates all 11 namespaces.
- [ ] `client.org(slug)` carries `mode` and `allowCrossOrg` through proxy hops; tests cover OAuth+`/mcp`, OAuth+`/mcp/{slug}`, PAT+`/mcp`, PAT+`/mcp/{wrong-slug}`.
- [ ] Output cap test: a script that returns >1 MB JSON gets the structured error.
- [ ] `list_organizations` response includes `is_current` (true for the token's bound org).
- [ ] `query_sql` with `org_slug` works on OAuth+`/mcp` for member orgs; rejected on scoped, on PAT, and for non-member orgs.
- [ ] `search` results include `usage_example` for the ~10 hot-path methods.
- [ ] Preamble updated in-place to reference `query` / `run`.
- [ ] CHANGELOG entry for `execute` → `run` rename and `manage_*` demotion to internal.
- [ ] No submodule PR needed (verified: owletto-web has no tool-name pattern matchers on `'execute'`).
- [ ] `bun run typecheck` clean; `make build-packages` clean; integration tests green.

## Open questions to confirm during PR

1. **`save_knowledge` return contract.** Verify the existing handler returns a stable `event_id` and that the `supersedes_event_id` flow (a) returns the new event ID and (b) hides the prior event from default `search_knowledge`. Add regression test if missing.
2. **`search_knowledge` provenance fields.** Verify results include org slug, source/connector, timestamp, and confidence/relevance score. Pin via integration test.
3. **`query_sql` SQL syntax for cross-org.** When `org_slug` is provided on unscoped, confirm the existing `validateAndScopeQuery` cleanly re-scopes to that org without per-table prefix collisions.

## Out of scope (next plans, not this one)

- Per-method confirmation policies (e.g. `entities.delete` always requires confirm even from `run`). Host UI handles destructive confirmation today; revisit only if a concrete UX gap shows up.
- A `bash`-style imperative tool surface. Explicitly rejected by the predecessor plan.
- A dedicated `forget_knowledge` tool. Forget is a write — handled via `save_knowledge` with `supersedes_event_id` or a `withdrawn` status event.
- Hard-delete of memory events from MCP. Append-only is the contract. If admin-only platform tooling ever needs a hard-delete, it lives outside any agent-facing API.
- An `include_history` flag on `search_knowledge`. History walks happen via REST/session admin tools or owletto-web, never via MCP.
- An `mcp://owletto/docs/*` resources subsystem. Considered and rejected — preamble + tool descriptions + `search` cover what agents need. Revisit only on concrete gap.
