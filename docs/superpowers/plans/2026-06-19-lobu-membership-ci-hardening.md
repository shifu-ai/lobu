# Lobu Membership CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personal-agent membership provisioning PR pass CI while preserving the real onboarding -> context-pack memory write contract.

**Architecture:** Keep production code small: provisioning creates the Toolbox owner member row, memory route enforces that the owner is a member, and tests prove the durable write path without process-wide mock pollution. Split tool schemas that are only needed for registry metadata away from runtime tool modules to remove circular initialization failures.

**Tech Stack:** Bun test runner, Hono route tests, Lobu Postgres-backed stores, TypeScript, GitHub Actions.

---

### File Structure

- Modify: `packages/server/src/lobu/__tests__/memory-routes.test.ts`
  - Owns route-level authorization and ownership tests for `/lobu/api/v1/memory/context-packs`.
  - Owns service-level durable write tests for `writeContextPackMemory` using dependency injection instead of global mocks.
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`
  - Remove unnecessary global route mocks if they leak into later integration tests.
- Modify: `packages/server/src/tools/registry.ts`
  - Keep registry tool metadata import-safe by avoiding runtime imports from modules that import registry back.
- Modify: `packages/server/src/tools/save_content.ts`
  - Keep `saveContent` runtime behavior unchanged while importing its schema from a schema-only module.
- Create: `packages/server/src/tools/save_content_schema.ts`
  - Exports `SaveContentSchema` and `SaveContentArgs` with no imports from registry or runtime tool code.

### Task 1: Memory Route Test Isolation Tracer Bullet

**Files:**
- Modify: `packages/server/src/lobu/__tests__/memory-routes.test.ts`

- [ ] **Step 1: Replace route success assertions that require real `saveContent` URL building**

Remove route tests that expect a successful 200 response from real `saveContent` when the test does not initialize the full workspace URL provider. Keep route tests for failures that happen before save.

Use this shape in `describe('Toolbox context pack memory route', ...)`:

```ts
test('rejects read-only PAT scopes for memory writes', async () => {
  auth.mcpAuthInfo = { scopes: ['mcp:read'] };
  const app = await importMountedMemoryRoutes();

  const res = await app.request('/lobu/api/v1/memory/context-packs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(contextPackBody()),
  });

  expect(res.status).toBe(403);
  await expect(res.json()).resolves.toMatchObject({
    ok: false,
    errorCode: 'lobu_memory_write_forbidden',
    errorMessage: expect.any(String),
  });
});
```

- [ ] **Step 2: Add service-level durable write test with injected persistence**

Add a second `describe('writeContextPackMemory', ...)` in the same file:

```ts
test('writes a durable context pack memory ref', async () => {
  const { writeContextPackMemory } = await import('../memory-routes.js?memory-service-test');
  const calls: unknown[] = [];

  const result = await writeContextPackMemory(
    {
      organizationId: ORG_ID,
      authSource: 'pat',
      scopes: ['mcp:admin'],
      ownerMemberRole: 'member',
      body: contextPackBody(),
    },
    {
      saveContentImpl: async (args, _env, ctx) => {
        calls.push({ args, ctx });
        return {
          id: 123,
          entity_ids: [],
          title: args.title,
          semantic_type: args.semantic_type,
          created_at: '2026-06-18T00:00:00.000Z',
          view_url: 'https://app.example.test/events/123',
        };
      },
    }
  );

  expect(result).toEqual({
    ok: true,
    refs: ['lobu:event:123'],
    memory: {
      eventId: 123,
      viewUrl: 'https://app.example.test/events/123',
      semanticType: 'project_profile',
      agentId: AGENT_ID,
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    args: {
      semantic_type: 'project_profile',
      metadata: {
        owner_user_id: OWNER_USER_ID,
        agent_id: AGENT_ID,
        memory_source: 'toolbox_onboarding',
      },
    },
    ctx: {
      organizationId: ORG_ID,
      userId: OWNER_USER_ID,
      memberRole: 'member',
      tokenType: 'pat',
    },
  });
});
```

- [ ] **Step 3: Add service-level failed durable id test**

```ts
test('does not return 2xx when saveContent returns no durable id', async () => {
  const { ContextPackMemoryError, writeContextPackMemory } = await import(
    '../memory-routes.js?memory-service-failed-id-test'
  );

  await expect(
    writeContextPackMemory(
      {
        organizationId: ORG_ID,
        authSource: 'pat',
        scopes: ['mcp:admin'],
        ownerMemberRole: 'member',
        body: contextPackBody(),
      },
      {
        saveContentImpl: async () => ({
          id: 0,
          entity_ids: [],
          title: null,
          semantic_type: 'project_profile',
          created_at: '2026-06-18T00:00:00.000Z',
        }),
      }
    )
  ).rejects.toMatchObject({
    errorCode: 'lobu_memory_write_failed',
  });
  expect(ContextPackMemoryError).toBeDefined();
});
```

- [ ] **Step 4: Run focused test**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/server/src/lobu/__tests__/memory-routes.test.ts
```

Expected: all tests in `memory-routes.test.ts` pass.

- [ ] **Step 5: Commit after the tracer bullet passes**

```bash
git add packages/server/src/lobu/__tests__/memory-routes.test.ts
git commit -m "test: isolate memory context pack coverage"
```

### Task 2: Registry Circular Initialization Hardening

**Files:**
- Modify: `packages/server/src/tools/registry.ts`
- Modify: `packages/server/src/tools/save_content.ts`
- Create: `packages/server/src/tools/save_content_schema.ts`

- [ ] **Step 1: Extract `SaveContentSchema` into schema-only module**

Create `packages/server/src/tools/save_content_schema.ts` with the exact `Type.Object(...)` schema previously exported from `save_content.ts` and:

```ts
export type SaveContentArgs = Static<typeof SaveContentSchema>;
```

- [ ] **Step 2: Update `save_content.ts` to import schema and type**

Replace the in-file schema declaration with:

```ts
import { SaveContentSchema, type SaveContentArgs } from './save_content_schema';
```

Do not change `saveContent` behavior.

- [ ] **Step 3: Update `registry.ts` to avoid importing executable organization module schema**

Use local JSON-schema metadata for `list_organizations`:

```ts
const ListOrganizationsInputSchema = {
  type: 'object',
  properties: {
    search: {
      type: 'string',
      description: 'Filter organizations by name (case-insensitive substring match)',
    },
  },
} as const;
```

Set:

```ts
inputSchema: ListOrganizationsInputSchema,
```

- [ ] **Step 4: Run unit reproduction**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/server/src/auth/__tests__/tool-access.test.ts
```

Expected: pass, no `Cannot access 'ListOrganizationsSchema' before initialization` and no `Cannot access 'SaveContentSchema' before initialization`.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/registry.ts packages/server/src/tools/save_content.ts packages/server/src/tools/save_content_schema.ts
git commit -m "fix: isolate tool registry schemas"
```

### Task 3: Remove Integration Mock Leakage

**Files:**
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`

- [ ] **Step 1: Search for global route mocks**

Run:

```bash
rg "mock.module\\(\"\\.\\./agent-routes|mock.module\\('\\.\\./agent-routes" packages/server/src/lobu/__tests__/provisioning-routes.test.ts
```

Expected: find only mocks that replace `../agent-routes` / `../agent-routes.js`.

- [ ] **Step 2: Remove only unnecessary `../agent-routes` mocks**

Delete:

```ts
mock.module('../agent-routes', () => ({ agentRoutes: new Hono(), toolboxMcpRoutes: new Hono() }));
mock.module('../agent-routes.js', () => ({ agentRoutes: new Hono(), toolboxMcpRoutes: new Hono() }));
```

Keep mocks required for external SDK or workspace behavior unless a focused test proves they are no longer needed.

- [ ] **Step 3: Run focused provisioning tests**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts
```

Expected: pass.

- [ ] **Step 4: Run integration-order reproduction**

Run from `packages/server`:

```bash
cd packages/server
/Users/hua/.bun/bin/bun test src/lobu/__tests__ src/workspace/__tests__
```

Expected: pass. If another global mock leakage appears, remove the narrowest mock causing it and rerun this same command.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lobu/__tests__/provisioning-routes.test.ts
git commit -m "test: prevent lobu route mock leakage"
```

### Task 4: Full Local Verification and PR Push

**Files:**
- No new implementation files unless previous tasks reveal a focused fix.

- [ ] **Step 1: Run focused route and script tests**

```bash
/Users/hua/.bun/bin/bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts packages/server/src/lobu/__tests__/memory-routes.test.ts
node --test packages/server/scripts/repair-toolbox-personal-agent-memberships.test.mjs
```

Expected: pass.

- [ ] **Step 2: Run unit failure reproduction**

```bash
/Users/hua/.bun/bin/bun test packages/server/src/auth/__tests__/tool-access.test.ts
```

Expected: pass.

- [ ] **Step 3: Run typecheck**

```bash
/Users/hua/.bun/bin/bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Run whitespace diff check**

```bash
git diff --check shifu/main...HEAD
```

Expected: no output.

- [ ] **Step 5: Push PR branch and watch checks**

```bash
git push shifu HEAD:codex/personal-agent-membership-provisioning-spec
gh pr checks 4 --repo shifu-ai/lobu --watch --interval 10
```

Expected: CI no longer fails on `tool-access.test.ts`, `memory-routes.test.ts`, or route mock leakage. If `cli-smoke` / `sdk-e2e` still fail with SSE 401, inspect logs and treat as the next task rather than declaring complete.

### Self-Review

- Spec coverage: This plan covers the observed failing paths after the membership provisioning implementation: memory route contract, registry circular import, integration mock pollution, and PR verification.
- Tracer bullet: Task 1 proves the riskiest end-to-end contract at the service boundary while keeping route auth tests real and DB-backed.
- Placeholder scan: No placeholder tasks remain; each step names paths, commands, and expected output.
- Type consistency: `SaveContentArgs`, `SaveContentSchema`, `writeContextPackMemory`, and `ContextPackMemoryError` match current code symbols.
