# Lobu Runtime Memory Write Contract Spec

Date: 2026-06-18

## Background

Toolbox staging now submits LINE onboarding project context into Toolbox and can build a D1 context pack / discovery run. The remaining failure is long-term Lobu memory write.

Live probe from the Gateway environment returned:

```json
{
  "status": 400,
  "ok": false,
  "body": {
    "ok": false,
    "errorCode": "lobu_mcp_invalid_request",
    "hasContent": false
  }
}
```

The probe called:

```text
POST /lobu/api/v1/mcp/tools/call
connectorKey = lobu_memory
toolName = save_memory
```

This failed because the current Toolbox MCP execution route is a discovery-tool proxy, not a memory write contract:

- `packages/server/src/lobu/agent-routes.ts` requires `connectionRef`.
- `connectorKey` is limited to `notion | google_workspace`.
- `save_memory` is not in the discovery allowlist.
- The route verifies an attached external MCP connection before executing.

That contract is correct for Notion / Google Workspace discovery, but wrong for server-side project context memory writes.

## Problem

Toolbox needs to tell Lobu:

```text
For Toolbox user X and personal agent shifu-u-*, persist this project context pack as durable memory.
```

Lobu currently has the low-level memory writer:

```text
save_memory -> packages/server/src/tools/save_content.ts
```

But there is no first-class HTTP contract for a trusted server caller to write a project profile memory record without pretending memory is an external MCP connector.

As a result, Toolbox can only truthfully say:

```text
context pack / discovery run created
memory write failed
```

It must not say long-term memory is complete until Lobu returns a durable memory reference.

## Goals

1. Add a first-class Lobu runtime memory write contract for server-side Toolbox onboarding.
2. Reuse Lobu's existing append-only memory/event path instead of creating a second memory store.
3. Return a durable ref that Toolbox can store as `contextPack.memoryWriteRefs`.
4. Keep auth and org/user/agent scoping explicit.
5. Avoid raw secret or raw internal error leakage.
6. Work correctly with N>1 app replicas; no in-memory state handoff.
7. Keep `/mcp/tools/call` focused on external discovery MCP tools.

## Non-Goals

- Do not make `lobu_memory` a fake discovery connector.
- Do not loosen `/mcp/tools/call` to allow arbitrary Lobu tools.
- Do not write directly to a local worker filesystem or session file.
- Do not bypass `saveContent` / event-kind validation / membership-write semantics.
- Do not require Owletto UI, Chrome extension, or Mac app changes.
- Do not deploy from local source; Lobu deploy remains GitHub Actions image build -> GHCR -> Zeabur image service.

## Recommended Contract

Add:

```text
POST /lobu/api/v1/memory/context-packs
```

This is a server/API route, not an MCP route.

### Auth

The route must use existing `mcpAuth` and organization context.

Allowed callers:

- PAT with `mcp:write` or `mcp:admin` for the current organization.
- Session caller whose `user.id` matches `ownerUserId`.

Recommended helper:

```ts
requireSessionOrMemoryWritePat(c, ownerUserId)
```

Policy:

- `session`: user must equal `ownerUserId`.
- `pat`: allow `mcp:write` or `mcp:admin`.
- No anonymous access.
- Never print token values in logs or responses.

This mirrors the intent of `save_memory`: write-tier access is enough for member-owned memory, while admin PATs can perform trusted server writes.

### Request

```ts
interface CreateContextPackMemoryRequest {
  ownerUserId: string;
  agentId: string;
  semanticType?: 'project_profile';
  title: string;
  summary: string;
  content: string;
  metadata: {
    source: 'toolbox_onboarding';
    contextPackId: string;
    projectSeedId: string | null;
    discoveryRunId: string | null;
    projectTitle: string;
    confidence: 'low' | 'medium' | 'high';
    generatedAt: string;
    evidenceRefs: Array<{
      evidenceId: string;
      source: string;
      sourceId: string;
      title: string;
      url: string | null;
      confidence: string;
      score: number;
    }>;
    candidateEvidenceRefs?: Array<{
      evidenceId: string;
      source: string;
      sourceId: string;
      title: string;
      url: string | null;
      confidence: string;
      score: number;
    }>;
  };
}
```

Server-side normalization:

- `semanticType` defaults to `project_profile`.
- Lobu writes `semantic_type = semanticType`.
- Lobu writes `payload_type = markdown`.
- Lobu writes `content = request.content`.
- Lobu writes `title = request.title`.
- Lobu writes `author = Toolbox Onboarding`.
- Lobu metadata must include:

```ts
{
  ...request.metadata,
  owner_user_id: ownerUserId,
  agent_id: agentId,
  memory_source: 'toolbox_onboarding',
}
```

Use snake_case metadata keys for Lobu search compatibility. In particular, `agent_id` is important because `search_memory` already filters on `events.metadata.agent_id`.

### Response

Success:

```ts
interface CreateContextPackMemoryResponse {
  ok: true;
  refs: string[];
  memory: {
    eventId: number;
    viewUrl: string | null;
    semanticType: 'project_profile';
    agentId: string;
  };
}
```

Rules:

- `refs` must contain at least one durable ref.
- Recommended ref format: `lobu:event:<eventId>`.
- A 2xx response with no durable ref is invalid and must not be returned.

Failure:

```ts
interface CreateContextPackMemoryError {
  ok: false;
  errorCode:
    | 'lobu_memory_invalid_request'
    | 'lobu_memory_unauthorized'
    | 'lobu_memory_write_forbidden'
    | 'lobu_memory_semantic_type_invalid'
    | 'lobu_memory_write_failed';
  errorMessage: string;
}
```

Error responses must be safe for Toolbox to store/display. Do not include raw token values, SQL text, stack traces, OAuth credentials, or raw upstream error payloads.

## Implementation Shape

### Route location

Preferred file:

```text
packages/server/src/lobu/memory-routes.ts
```

Then mount from `packages/server/src/lobu/agent-routes.ts` or the same parent router that exposes `/lobu/api/v1`.

Keep this separate from the existing discovery MCP proxy code in `agent-routes.ts`, because the semantics are different:

- discovery proxy: external connection + allowlisted tool execution
- memory write: internal durable Lobu event write

### Service location

Preferred file:

```text
packages/server/src/lobu/context-pack-memory-service.ts
```

Responsibility:

- Validate/coerce request.
- Build `SaveContentSchema`-compatible args.
- Construct a `ToolContext`.
- Call `saveContent(args, env, ctx)`.
- Convert `SaveContentResult` into the memory response contract.

### ToolContext construction

For trusted server writes, call `saveContent` with:

```ts
{
  organizationId,
  userId: ownerUserId,
  memberRole: resolvedRole,
  agentId,
  isAuthenticated: true,
  scopes: ['mcp:write'],
  tokenType: 'pat' | 'session',
  scopedToOrg: true,
  allowCrossOrg: false,
  requestUrl,
  baseUrl,
}
```

The route must verify membership for `ownerUserId` in the current org before calling `saveContent`. If the user is not a member, return:

```text
403 lobu_memory_write_forbidden
```

Do not use a system context with `userId = null` for Toolbox onboarding memory, because the saved event should be attributable to the Toolbox user and searchable by `agent_id`.

## Why Not Extend `/mcp/tools/call`

Extending `/mcp/tools/call` for memory looks attractive but mixes two contracts:

1. External MCP discovery calls require `connectionRef` and attached connection readiness.
2. Lobu memory writes require org/member write access and durable event insertion.

If `/mcp/tools/call` accepted `lobu_memory` without `connectionRef`, it would create special cases:

- special connector key
- special readiness bypass
- special allowlist
- special response parsing

That makes future debugging harder and weakens the current discovery proxy boundary. A first-class REST memory route is clearer and easier to smoke-test.

## Validation Rules

Reject with `400 lobu_memory_invalid_request` when:

- `ownerUserId` is missing or blank.
- `agentId` is missing or blank.
- `title`, `summary`, or `content` is missing or blank.
- `metadata.contextPackId` is missing or blank.
- `metadata.source !== 'toolbox_onboarding'`.
- `metadata.evidenceRefs` is not an array.
- JSON body is invalid.

Reject with `422 lobu_memory_semantic_type_invalid` when:

- `saveContent` rejects the semantic type / event kind.

Reject with `403 lobu_memory_write_forbidden` when:

- caller is not allowed to write for `ownerUserId`.
- `ownerUserId` is not a member of the current organization.

Reject with `500 lobu_memory_write_failed` only for unexpected failures.

## Search / Readback Expectation

After a successful write:

```text
search_memory({ query: "<project title>", agent_id: "<agentId>" })
```

should be able to find the saved memory after indexing/backfill catches up.

Immediate smoke should not require embeddings. A direct event read by returned `eventId` is enough for contract verification.

## Tests

Add tests in:

```text
packages/server/src/lobu/__tests__/memory-routes.test.ts
```

Required cases:

1. `POST /memory/context-packs` writes a project profile and returns `refs: ["lobu:event:<id>"]`.
2. Response includes `memory.eventId`, `semanticType`, `agentId`, and optional `viewUrl`.
3. Saved event metadata includes `agent_id`, `owner_user_id`, `contextPackId`, and `memory_source`.
4. Missing required fields return `400 lobu_memory_invalid_request`.
5. Unauthorized caller returns `401` or `403` without writing.
6. Session caller for a different `ownerUserId` returns `403`.
7. PAT without write/admin scope returns `403`.
8. Semantic type validation failure maps to `422 lobu_memory_semantic_type_invalid`.
9. No response path returns `ok: true` without at least one durable ref.
10. Error response does not include thrown stack traces or raw internal messages.

Recommended integration/smoke test:

```text
POST /lobu/api/v1/memory/context-packs
Authorization: Bearer <Gateway LOBU_API_TOKEN>
```

From the Gateway Zeabur service environment, using `LOBU_BASE_URL` and `LOBU_API_TOKEN`, print only:

```json
{
  "status": 200,
  "ok": true,
  "refs": ["lobu:event:123"],
  "eventId": 123
}
```

Never print token values.

## Toolbox Follow-Up

Once this contract exists in a deployed Lobu image, Toolbox should change `LobuMemoryClient` from:

```text
POST /mcp/tools/call
connectorKey = lobu_memory
toolName = save_memory
```

to:

```text
POST /memory/context-packs
```

Toolbox must continue to require at least one durable ref before marking memory as `written`.

## Deployment

Lobu deployment path after implementation:

1. Implement in a Lobu worktree.
2. Run focused Lobu tests.
3. Push to `shifu-ai/lobu`.
4. Build image via GitHub Actions.
5. Confirm GHCR image is pullable.
6. Update Zeabur `lobu-image` to the new prebuilt image.
7. Verify:

```text
GET /health
POST /lobu/api/v1/memory/context-packs
```

Do not deploy Lobu source directly to Zeabur.

## Acceptance Criteria

- Lobu exposes `POST /lobu/api/v1/memory/context-packs`.
- A Gateway PAT with write/admin scope can write a Toolbox onboarding context pack.
- Response contains a durable memory ref.
- Missing durable refs are treated as failure.
- Saved event is scoped to organization, owner user, and agent id.
- Search/readback can confirm the memory exists.
- Toolbox can store the returned ref and truthfully report memory written.
- Existing `/mcp/tools/call` discovery behavior remains unchanged for Notion / Google Workspace.

## Open Questions

1. Should `project_profile` be auto-seeded as a default event kind for personal agent orgs, or should the route map to an existing semantic type if `project_profile` is absent?
2. Should the route accept multiple context packs in one batch, or remain single-write for traceability?
3. Should returned refs be only `lobu:event:<id>`, or also include `view_url` as a ref-like value for UI convenience?
4. Should Toolbox smoke verify readback through `search_memory` once embeddings/indexing are available, or only direct event read by `eventId`?
