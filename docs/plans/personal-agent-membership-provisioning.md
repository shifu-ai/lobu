# Personal Agent Membership Provisioning Spec

Date: 2026-06-19

## Background

Toolbox staging now routes LINE / Agent Workbench onboarding completion through:

```text
POST /agent-workbench/product/internal/onboarding-completed
```

That path can:

- accept a valid internal onboarding payload;
- run project discovery;
- create a Toolbox project seed, discovery run, and context pack;
- call Lobu's new memory route:

```text
POST /lobu/api/v1/memory/context-packs
```

Live staging smoke still returns:

```json
{
  "memory": {
    "lobu": {
      "status": "failed",
      "errorCode": "lobu_memory_write_failed",
      "message": "Lobu memory write failed"
    }
  }
}
```

Direct Lobu probes narrowed the failure to authorization, not route availability:

```json
{
  "status": 403,
  "response": {
    "ok": false,
    "errorCode": "lobu_memory_write_forbidden",
    "errorMessage": "ownerUserId is not a member of this organization"
  }
}
```

The real staging personal agent also shows the same shape:

```text
agentId = shifu-u-a4175b7e71f4
organization_id = org_peRVYvsqsWk
owner_platform = toolbox
owner_user_id = 20a9e88f-972b-4745-a467-4f45c4198650
```

But the Lobu `member` table for `org_peRVYvsqsWk` does not contain that `owner_user_id`. The memory route correctly rejects the write because `saveContent` needs an organization member role for the effective owner.

## Problem

Lobu provisioning currently stores Toolbox ownership on the agent:

```text
agents.owner_platform = toolbox
agents.owner_user_id = <toolbox user id>
```

It does not guarantee the matching workspace membership invariant:

```text
member."organizationId" = agents.organization_id
member."userId" = agents.owner_user_id
```

That leaves a partially provisioned personal agent:

```text
Toolbox can route LINE to the deterministic shifu-u-* agent.
Toolbox can attach settings / MCP grants / owner metadata.
Lobu memory writes reject the owner because the owner is not a Lobu org member.
```

This breaks the onboarding chain at the final durable memory step. It also makes Agent Workbench show "context pack created" while long-term memory remains unfinished.

## Goals

1. Make `POST /api/provisioning/agents` establish a complete personal-agent ownership contract.
2. Ensure every `shifu-u-*` Toolbox owner is a member of the Lobu organization that owns the agent.
3. Keep `/memory/context-packs` authorization strict; do not bypass the membership check.
4. Make provisioning idempotent and safe under repeated Toolbox route calls.
5. Provide a backfill path for already-provisioned `shifu-u-*` agents.
6. Give Toolbox / LINE a staging smoke that proves onboarding returns `memoryWriteStatus: written` and a `lobu:event:*` ref.
7. Avoid printing or storing secrets in test output, logs, or docs.

## Non-Goals

- Do not loosen `/lobu/api/v1/memory/context-packs` to allow non-members.
- Do not treat `mcp:admin` as permission to write memory as an arbitrary non-member owner.
- Do not create a separate Toolbox-only memory store.
- Do not bypass `saveContent`, event-kind validation, append-only `events`, or existing org scoping.
- Do not change Toolbox's deterministic `shifu-u-*` agent id strategy.
- Do not require Owletto UI, Chrome extension, or Mac app work.
- Do not deploy from local source. Lobu runtime rollout remains GitHub Actions image build -> GHCR -> Zeabur image service.

## Required Invariant

For every Toolbox-provisioned personal agent:

```text
agent.id starts with shifu-u-
agent.owner_platform = toolbox
agent.owner_user_id = ownerUserId
agent.organization_id = organizationId
```

Lobu must also guarantee:

```text
member."organizationId" = organizationId
member."userId" = ownerUserId
member.role in ('member', 'admin', 'owner')
```

Recommended default role for external Toolbox users:

```text
role = member
```

Rationale:

- The Workspace owner PAT remains the administrative caller.
- The Toolbox user owns their personal agent data.
- Memory writes execute as the Toolbox owner, but with ordinary member privileges.
- This preserves existing owner/admin-only operations.

## Provisioning Contract

Endpoint:

```text
POST /lobu/api/provisioning/agents
Authorization: Bearer <organization-scoped mcp:admin PAT>
```

Current accepted request shape remains:

```ts
interface ProvisionUserAgentRequest {
  agentId: `shifu-u-${string}`;
  name: string;
  description?: string;
  ownerUserId?: string;
  settings?: Record<string, unknown>;
}
```

Server-side behavior after this spec:

1. Validate the caller as an organization-scoped PAT with `mcp:admin`.
2. Resolve `organizationId` from the authenticated request context.
3. Resolve `ownerUserId`:
   - if request contains non-empty `ownerUserId`, use the trimmed value;
   - otherwise use the authenticated PAT user id.
4. Upsert agent metadata and settings as today.
5. Upsert `agent_users` ownership as today where applicable.
6. Ensure Lobu membership:

```sql
INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
VALUES (<generated id>, <organizationId>, <ownerUserId>, 'member', now())
ON CONFLICT ("organizationId", "userId") DO NOTHING;
```

If the existing member row has role `admin` or `owner`, keep it. Do not downgrade roles.

Response can stay compatible:

```ts
interface ProvisionUserAgentResponse {
  ok: true;
  agentId: string;
  created: boolean;
  revisionRef: `lobu:${string}`;
}
```

Optional addition:

```ts
membership: {
  ensured: true;
  role: 'member' | 'admin' | 'owner';
}
```

If this field is added, clients must not depend on it for correctness; it is diagnostic only.

## Backfill Contract

Existing staging / production records may already have:

```text
agents.owner_platform = toolbox
agents.owner_user_id IS NOT NULL
```

without a matching `member` row. Implementation must include one of:

1. an idempotent migration / repair script, or
2. a provisioning-time repair that fixes existing records whenever Toolbox calls the route again.

Preferred approach:

- Implement provisioning-time repair first so re-provisioning a user fixes the common path.
- Add an explicit no-secret admin smoke/backfill command for known staging agents.
- Only add a broad migration if production data volume requires it.

Backfill query shape:

```sql
SELECT a.organization_id, a.owner_user_id
FROM agents a
LEFT JOIN "member" m
  ON m."organizationId" = a.organization_id
 AND m."userId" = a.owner_user_id
WHERE a.id LIKE 'shifu-u-%'
  AND a.owner_platform = 'toolbox'
  AND a.owner_user_id IS NOT NULL
  AND m.id IS NULL;
```

Every backfilled row must be inserted with `role = 'member'` unless a role already exists.

## Memory Route Contract Must Stay Strict

`POST /lobu/api/v1/memory/context-packs` should continue enforcing:

- authenticated organization context exists;
- caller has session owner identity or PAT/OAuth write/admin scope;
- `agentId` exists and is owned by `ownerUserId`;
- `ownerUserId` is a member of the current organization;
- `saveContent` returns a durable event id;
- no 2xx is returned without a `lobu:event:*` ref.

This spec intentionally fixes provisioning instead of weakening this route.

## Expected Test Coverage

Update or add tests around:

```text
packages/server/src/lobu/provisioning-routes.ts
packages/server/src/lobu/__tests__/provisioning-routes.test.ts
packages/server/src/lobu/memory-routes.ts
packages/server/src/lobu/__tests__/memory-routes.test.ts
```

Required cases:

1. `POST /api/provisioning/agents` with `ownerUserId` creates or preserves a matching `member` row.
2. Repeating the same provisioning request is idempotent and creates only one member row.
3. Existing `admin` / `owner` membership is preserved and not downgraded.
4. Blank `ownerUserId` is still rejected.
5. Non-`shifu-u-*` agent ids are still rejected.
6. A newly provisioned Toolbox personal agent can immediately call `/memory/context-packs` with the same `ownerUserId` and receive `refs: ['lobu:event:<id>']`.
7. A mismatched `ownerUserId` is still rejected by `/memory/context-packs`.
8. No test prints PATs, database URLs, OAuth tokens, or connection secrets.

## Staging Verification

After implementation is merged and deployed through the supported Lobu image path:

1. Confirm Lobu image health shows the intended revision:

```bash
curl -fsS https://shifulobu.zeabur.app/health
```

2. From the LINE Gateway Zeabur environment, use `TOOLBOX_INTERNAL_SECRET` without printing it to call Toolbox provisioning for a synthetic user.

3. Submit onboarding to:

```text
POST https://shifu-system-api-staging.ai-126.workers.dev/agent-workbench/product/internal/onboarding-completed
```

Expected response subset:

```json
{
  "ok": true,
  "status": "completed",
  "discovery": {
    "results": [
      {
        "memoryWriteStatus": "written",
        "sourceStatuses": {
          "memory": {
            "lobu": {
              "status": "written"
            }
          }
        }
      }
    ]
  }
}
```

The stored context pack must include at least one durable ref:

```text
lobu:event:<positive integer>
```

4. Re-run the same smoke for the real staging personal agent after explicit user approval, or rely on the next natural re-provisioning path if avoiding any writes to the user's account.

## Acceptance Criteria

- Provisioning a Toolbox personal agent creates a complete owner -> agent -> org membership graph.
- Existing `shifu-u-*` agents can be repaired by re-provisioning or backfill without manual database edits.
- `/memory/context-packs` still rejects non-member owners.
- Toolbox onboarding smoke returns `memoryWriteStatus: written`.
- Toolbox stores `lobu:event:*` in `contextPack.memoryWriteRefs`.
- LINE can truthfully say project background submission and long-term memory/index creation completed only after the durable ref exists.

