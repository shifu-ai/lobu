# Lobu Runtime Memory Write Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Each task has an independent verification command and must keep secrets out of logs.

**Goal:** Add a first-class Lobu API route that lets Toolbox submit onboarding context packs as durable memory, returning a verifiable reference that Toolbox can surface as "index/memory created" evidence.

**Architecture:** Keep external MCP tool execution and internal product memory writes separate. Toolbox writes onboarding context through `POST /lobu/api/v1/memory/context-packs`; Lobu validates caller identity, owner/agent binding, semantic type, and write scopes, then delegates to the existing `saveContent` memory primitive. The response is only successful when a durable event ref exists.

**Tech Stack:** Hono routes, existing Lobu `mcpAuth`, `saveContent`, `$member.event_kinds`, Bun tests, Zeabur/GHCR deployment handoff only after CI image build.

---

## Current Findings

- Toolbox cannot use `POST /lobu/api/v1/mcp/tools/call` for memory writes because that route requires an MCP `connectionRef`, only accepts `notion` or `google_workspace` connector keys, and only allows discovery tools.
- Existing Lobu `save_memory` already writes durable `events` rows through `saveContent`, but it is exposed as a workspace tool, not as a product-facing context pack write route.
- `saveContent` validates `semantic_type` against `$member.event_kinds`. The default `$member` event kinds do not include `project_profile`, so a product route must either use an existing kind like `summary` or explicitly add/seed a new allowed kind.
- Toolbox needs a hard contract: no HTTP 2xx unless the returned payload includes a durable `memoryRef`.

## Contract

Endpoint:

```http
POST /lobu/api/v1/memory/context-packs
Authorization: Bearer <LOBu PAT or session>
Content-Type: application/json
```

Request:

```json
{
  "ownerUserId": "toolbox-user-id",
  "agentId": "shifu-u-a4175b7e71f4",
  "source": "toolbox_onboarding",
  "title": "超級AI個體 onboarding context pack",
  "content": "Markdown context pack body...",
  "semanticType": "project_profile",
  "metadata": {
    "contextPackId": "ctx_...",
    "projectSeedId": "seed_...",
    "discoveryRunId": "run_...",
    "projectTitle": "超級AI個體",
    "confidence": "low|medium|high",
    "generatedAt": "2026-06-18T..."
  }
}
```

Success:

```json
{
  "ok": true,
  "memoryRef": "lobu:event:12345",
  "eventId": 12345,
  "semanticType": "project_profile",
  "viewUrl": "https://..."
}
```

Failure shape:

```json
{
  "ok": false,
  "errorCode": "lobu_memory_invalid_request",
  "message": "Human safe explanation"
}
```

## Implementation Tasks

### 1. Add a failing tracer-bullet route test

- [ ] Create `packages/server/src/lobu/__tests__/memory-routes.test.ts`.
- [ ] Mount the same production route surface used by Toolbox:

```ts
const { toolboxMcpRoutes } = await import('../agent-routes.js');
const app = new Hono();
app.route('/lobu/api/v1', toolboxMcpRoutes);
```

- [ ] Mock auth using existing route helpers from `toolbox-mcp-execution-routes.test.ts`.
- [ ] Mock the memory service to return `{ memoryRef: 'lobu:event:123', eventId: 123 }`.
- [ ] Assert `POST /lobu/api/v1/memory/context-packs` returns `200` with `ok: true` and the durable ref.
- [ ] Verification:

```bash
bun test packages/server/src/lobu/__tests__/memory-routes.test.ts
```

### 2. Implement request validation and memory service

- [ ] Add `packages/server/src/lobu/context-pack-memory-service.ts`.
- [ ] Export a small pure validator for unit tests:

```ts
export function parseContextPackMemoryRequest(body: unknown): ContextPackMemoryRequest
```

- [ ] Validate required fields:
  - `ownerUserId`: non-empty string
  - `agentId`: valid Lobu agent id
  - `source`: currently only `toolbox_onboarding`
  - `title`: non-empty string, bounded length
  - `content`: non-empty markdown string, bounded length
  - `semanticType`: default to `project_profile`
  - `metadata`: object with bounded size

- [ ] Export the write function:

```ts
export async function writeContextPackMemory(input: {
  organizationId: string;
  callerUserId: string | null;
  scopes: string[];
  ownerUserId: string;
  agentId: string;
  requestUrl?: string;
  baseUrl?: string;
  body: unknown;
}): Promise<{
  memoryRef: string;
  eventId: number;
  semanticType: string;
  viewUrl?: string;
}>
```

- [ ] Reuse `saveContent` rather than inserting `events` directly.
- [ ] Build `saveContent` args with:
  - `payload_type: 'markdown'`
  - `semantic_type: semanticType`
  - `title`
  - `content`
  - `author: 'Toolbox Onboarding'`
  - metadata preserving Toolbox IDs plus `owner_user_id`, `agent_id`, `memory_source`.

- [ ] Convert `saveContent` result id to `memoryRef = lobu:event:<id>`.
- [ ] Throw `lobu_memory_write_failed` if `saveContent` returns no numeric id.

### 3. Decide and implement `project_profile` event kind support

- [ ] Add `project_profile` to the default `$member` event kinds in `packages/server/src/utils/member-entity-type.ts` unless product decides to use existing `summary`.
- [ ] Prefer adding `project_profile` because it gives Toolbox a stable semantic type and avoids mixing onboarding context packs with generic summaries.
- [ ] Update `ensureMemberEntityType` so existing orgs with non-null `$member.event_kinds` are merged with missing built-in kinds, not left stale forever.
- [ ] Keep existing custom org event kinds intact.
- [ ] Add unit coverage for:
  - newly created `$member` includes `project_profile`
  - existing `$member.event_kinds` keeps custom keys and receives missing built-ins
  - metadata for `project_profile` accepts Toolbox context pack metadata

### 4. Add the Hono route and mount it safely

- [ ] Add `packages/server/src/lobu/memory-routes.ts`.
- [ ] Use existing `mcpAuth` and org context; do not create a second auth system.
- [ ] Enforce caller authorization:
  - PAT callers need `mcp:write` or `mcp:admin`
  - session callers must match `ownerUserId`
  - request `agentId` must exist in the current org and be owned by `ownerUserId`
- [ ] Return explicit error codes:
  - `lobu_memory_invalid_request` -> 400
  - `lobu_memory_unauthorized` -> 401
  - `lobu_memory_write_forbidden` -> 403
  - `lobu_memory_semantic_type_invalid` -> 422
  - `lobu_memory_write_failed` -> 500
- [ ] Mount under `toolboxMcpRoutes`:

```ts
toolboxMcpRoutes.route('/memory', memoryRoutes);
```

This makes the embedded gateway path:

```text
/lobu/api/v1/memory/context-packs
```

### 5. Expand tests around failure modes

- [ ] Route rejects missing auth.
- [ ] PAT without `mcp:write`/`mcp:admin` is `403`.
- [ ] Session caller whose user id differs from `ownerUserId` is `403`.
- [ ] Unknown agent or agent owned by another user is `403`/`404` with no secret details.
- [ ] Invalid `semanticType` returns `422` and includes `lobu_memory_semantic_type_invalid`.
- [ ] Internal `saveContent` failure returns non-2xx and never includes `memoryRef`.
- [ ] Success response includes `memoryRef`, `eventId`, and `semanticType`.

Verification:

```bash
bun test \
  packages/server/src/lobu/__tests__/memory-routes.test.ts \
  packages/server/src/lobu/__tests__/toolbox-mcp-execution-routes.test.ts
```

### 6. Add a local smoke helper for Toolbox/Gateway handoff

- [ ] Add a no-secret script or documented command that can be run inside the Gateway Zeabur environment, using the live `LOBU_API_TOKEN` without printing it.
- [ ] The smoke must call:

```text
POST $LOBU_BASE_URL/lobu/api/v1/memory/context-packs
```

- [ ] It should print only:
  - HTTP status
  - `ok`
  - `memoryRef`
  - sanitized `errorCode`

- [ ] It must not print bearer tokens, database URLs, OAuth credentials, or full user secrets.

### 7. Document Toolbox integration change

- [ ] Update the contract note in `docs/plans/lobu-runtime-memory-write-contract.md` after implementation if field names change.
- [ ] Add a Toolbox-facing handoff section:
  - replace `/mcp/tools/call` memory write attempt with `/memory/context-packs`
  - treat missing `memoryRef` as failure
  - store `memoryRef` in Toolbox runtime event / project read model
  - show "long-term memory unfinished" only when this route fails or discovery evidence is insufficient

### 8. CI, image, and staging rollout handoff

- [ ] Run focused Lobu tests locally.
- [ ] Commit on the Lobu feature branch.
- [ ] Push branch and open PR against `shifu/main`.
- [ ] After review/merge, build the Lobu app image through GitHub Actions only.
- [ ] Confirm GHCR image is pullable:

```bash
docker manifest inspect ghcr.io/shifu-ai/lobu-app:<timestamp-tag>
```

- [ ] Update Zeabur `lobu-image` only to the GitHub Actions-built image.
- [ ] Do not deploy Lobu from local source.
- [ ] Verify:

```bash
curl -fsS https://shifulobu.zeabur.app/health
```

- [ ] Run Gateway-internal smoke without printing secrets.

## Acceptance Criteria

- Toolbox can submit an onboarding context pack without an MCP connection ref.
- Lobu writes a durable memory event and returns `memoryRef`.
- No 2xx response is possible when no durable memory ref exists.
- Unauthorized or mismatched user/agent writes are rejected.
- `project_profile` is accepted as a semantic type for existing and new orgs.
- Existing `/mcp/tools/call` discovery behavior remains unchanged.
- LINE onboarding can truthfully distinguish:
  - submitted memory
  - discovery/index still pending
  - write failed

## Rollback

- Revert the Lobu PR and redeploy the previous GHCR image tag to Zeabur.
- Toolbox should continue treating missing `memoryRef` as not completed, so rollback degrades to honest "memory unfinished" instead of false "submitted".

