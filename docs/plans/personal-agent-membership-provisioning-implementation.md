# Personal Agent Membership Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Toolbox-provisioned `shifu-u-*` personal agents complete Lobu's ownership graph by ensuring the Toolbox owner is also a member of the agent's Lobu organization, so onboarding context packs can write durable memory.

**Architecture:** Keep `/lobu/api/v1/memory/context-packs` strict and fix the upstream provisioning invariant. Add a small provisioning helper that idempotently inserts `member` rows for Toolbox owners, call it from `POST /api/provisioning/agents`, and add tests proving a newly provisioned personal agent can immediately write a context pack memory ref. Add a no-secret backfill/smoke script for already-provisioned agents.

**Tech Stack:** Hono Lobu provisioning routes, Postgres via `getDb()`, existing `member` unique key `("organizationId","userId")`, Bun tests, existing memory route tests, no local deploy.

---

## Source Spec

Implement `docs/plans/personal-agent-membership-provisioning.md`.

Important invariant:

```text
agents.owner_platform = toolbox
agents.owner_user_id = ownerUserId
agents.organization_id = organizationId
member."organizationId" = organizationId
member."userId" = ownerUserId
```

Do not loosen `packages/server/src/lobu/memory-routes.ts`.

## Files

- Modify: `packages/server/src/lobu/provisioning-routes.ts`
  - Add an idempotent `ensureToolboxOwnerMembership()` helper.
  - Call it after `ownerUserId` is resolved and before returning provisioning success.
  - Optionally return diagnostic membership info.
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`
  - Add tracer bullet test that provisioned owner gets a `member` row.
  - Add idempotency and role-preservation tests.
  - Add integration-style test that provisioning plus memory route now succeeds for the same owner/agent.
- Create: `packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs`
  - No-secret local/production-safe repair script for existing `shifu-u-*` Toolbox agents.
  - Supports dry-run by default and `--apply` for actual repair.
- Modify: `docs/plans/personal-agent-membership-provisioning.md`
  - Add implementation note naming the helper/script after code lands.

## Shared Code Patterns

Use Postgres quoted camelCase columns for `member`:

```ts
await sql`
  INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
  VALUES (${memberId}, ${organizationId}, ${ownerUserId}, 'member', NOW())
  ON CONFLICT ("organizationId", "userId") DO NOTHING
`;
```

Generate ids with `node:crypto` so no new dependency is required:

```ts
import { createHash, randomUUID } from "node:crypto";

function deterministicMembershipId(organizationId: string, ownerUserId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId]))
    .digest("hex")
    .slice(0, 24);
  return `member_${digest}`;
}
```

Either deterministic id or `randomUUID()` is acceptable because the uniqueness key is `("organizationId","userId")`. Prefer deterministic id in tests and scripts for easier auditing.

---

### Task 1: Tracer Bullet - Provisioning Creates Membership and Unblocks Memory

**Files:**
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`
- Modify: `packages/server/src/lobu/provisioning-routes.ts`

- [ ] **Step 1: Write the failing provisioning membership test**

In `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`, inside `describe("POST /api/provisioning/agents", ...)`, add:

```ts
test("ensures provided Toolbox owner is a member of the PAT organization", async () => {
  const app = await buildApp();

  const response = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "shifu-u-member-owner",
      name: "Toolbox Owner Member Agent",
      ownerUserId: "toolbox-user-member-1",
      settings: {},
    }),
  });

  expect(response.status).toBe(201);

  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  const members = await sql`
    SELECT "organizationId", "userId", role
    FROM "member"
    WHERE "organizationId" = ${ORG_ID}
      AND "userId" = ${"toolbox-user-member-1"}
  `;

  expect(members).toEqual([
    {
      organizationId: ORG_ID,
      userId: "toolbox-user-member-1",
      role: "member",
    },
  ]);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts -t "ensures provided Toolbox owner is a member"
```

Expected: FAIL because no `member` row is inserted.

- [ ] **Step 3: Implement minimal membership helper**

In `packages/server/src/lobu/provisioning-routes.ts`, update the import:

```ts
import { createHash } from "node:crypto";
```

Add:

```ts
import { getDb } from "../db/client.js";
```

Add near `deterministicProvisionedMcpConnectionRef()`:

```ts
function deterministicMembershipId(
  organizationId: string,
  ownerUserId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId]))
    .digest("hex")
    .slice(0, 24);
  return `member_${digest}`;
}

async function ensureToolboxOwnerMembership(
  organizationId: string,
  ownerUserId: string,
): Promise<{ ensured: true; role: string }> {
  const sql = getDb();
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (
      ${deterministicMembershipId(organizationId, ownerUserId)},
      ${organizationId},
      ${ownerUserId},
      'member',
      NOW()
    )
    ON CONFLICT ("organizationId", "userId") DO NOTHING
  `;

  const rows = await sql<{ role: string }[]>`
    SELECT role
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND "userId" = ${ownerUserId}
    LIMIT 1
  `;

  return { ensured: true, role: String(rows[0]?.role ?? "member") };
}
```

Inside `provisioningRoutes.post("/agents", ...)`, after `await configStore.saveSettings(...)` and before `await syncProvisioningGrants(...)`, add:

```ts
const membership = await ensureToolboxOwnerMembership(
  organizationId,
  ownerUserId,
);
```

Add `membership` to the JSON response:

```ts
membership,
```

- [ ] **Step 4: Run the tracer test again**

Run:

```bash
bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts -t "ensures provided Toolbox owner is a member"
```

Expected: PASS.

- [ ] **Step 5: Add the memory unblocked test**

Still in `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`, add a second test in the same describe block:

```ts
test("provisioned Toolbox owner can immediately satisfy memory-route membership", async () => {
  const app = await buildApp();

  const response = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "shifu-u-memory-member",
      name: "Memory Ready Agent",
      ownerUserId: "toolbox-user-memory-ready",
      settings: {},
    }),
  });

  expect(response.status).toBe(201);

  const { getWorkspaceRole } = await import("../../utils/organization-access.js");
  const { getDb } = await import("../../db/client.js");
  await expect(
    getWorkspaceRole(getDb(), ORG_ID, "toolbox-user-memory-ready"),
  ).resolves.toBe("member");
});
```

This test deliberately checks the same membership helper used by `memory-routes.ts`.

- [ ] **Step 6: Run the full provisioning route test file**

Run:

```bash
bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add packages/server/src/lobu/provisioning-routes.ts packages/server/src/lobu/__tests__/provisioning-routes.test.ts
git commit -m "fix: ensure toolbox agent owners are org members"
```

---

### Task 2: Idempotency, Role Preservation, and Compatibility Coverage

**Files:**
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`
- Modify: `packages/server/src/lobu/provisioning-routes.ts`

- [ ] **Step 1: Add idempotency test**

In `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`, inside `describe("POST /api/provisioning/agents", ...)`, add:

```ts
test("membership ensure is idempotent across repeated provisioning", async () => {
  const app = await buildApp();
  const body = {
    agentId: "shifu-u-idempotent-member",
    name: "Idempotent Member Agent",
    ownerUserId: "toolbox-user-idempotent",
    settings: {},
  };

  const first = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const second = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(first.status).toBe(201);
  expect(second.status).toBe(200);

  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  const rows = await sql`
    SELECT "organizationId", "userId", role
    FROM "member"
    WHERE "organizationId" = ${ORG_ID}
      AND "userId" = ${"toolbox-user-idempotent"}
  `;

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    organizationId: ORG_ID,
    userId: "toolbox-user-idempotent",
    role: "member",
  });
});
```

- [ ] **Step 2: Add role preservation test**

Add:

```ts
test("membership ensure preserves existing owner or admin roles", async () => {
  const { getDb } = await import("../../db/client.js");
  const sql = getDb();
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (
      ${"member_existing_admin"},
      ${ORG_ID},
      ${"toolbox-user-admin"},
      ${"admin"},
      NOW()
    )
  `;

  const app = await buildApp();
  const response = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "shifu-u-admin-owner",
      name: "Admin Owner Agent",
      ownerUserId: "toolbox-user-admin",
      settings: {},
    }),
  });

  expect(response.status).toBe(201);

  const rows = await sql`
    SELECT role
    FROM "member"
    WHERE "organizationId" = ${ORG_ID}
      AND "userId" = ${"toolbox-user-admin"}
  `;

  expect(rows).toEqual([{ role: "admin" }]);
});
```

- [ ] **Step 3: Assert response diagnostics without making clients depend on them**

In the existing test `"saves provided Toolbox owner user id instead of PAT user id"`, after `expect(response.status).toBe(201);`, add:

```ts
await expect(response.clone().json()).resolves.toMatchObject({
  ok: true,
  membership: {
    ensured: true,
    role: "member",
  },
});
```

If `Response.clone()` is not available in Bun's test Response, parse the JSON once and keep the body:

```ts
const body = await response.json();
expect(body).toMatchObject({
  ok: true,
  membership: {
    ensured: true,
    role: "member",
  },
});
```

Do not break existing `ok`, `agentId`, `created`, or `revisionRef` fields.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bun test packages/server/src/lobu/__tests__/provisioning-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add packages/server/src/lobu/provisioning-routes.ts packages/server/src/lobu/__tests__/provisioning-routes.test.ts
git commit -m "test: cover toolbox owner membership idempotency"
```

---

### Task 3: Memory Route Regression for Newly Provisioned Owners

**Files:**
- Modify: `packages/server/src/lobu/__tests__/memory-routes.test.ts`
- Modify: `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`

- [ ] **Step 1: Add a regression assertion to memory route tests**

In `packages/server/src/lobu/__tests__/memory-routes.test.ts`, keep the existing non-member rejection test. Add a comment above it clarifying that provisioning must fix membership, not this route:

```ts
test('rejects owners who are not organization members; provisioning must repair this', async () => {
  // This protects the security boundary that caused the staging smoke failure:
  // provisioning must create the member row, memory writes must not bypass it.
  ...
});
```

If the existing test name differs, rename only the test label and preserve its assertions.

- [ ] **Step 2: Add a provisioning-to-memory integration test seam**

In `packages/server/src/lobu/__tests__/provisioning-routes.test.ts`, add a test that proves the DB state produced by provisioning is exactly what `memory-routes.ts` requires:

```ts
test("provisioning creates the member row required by context-pack memory writes", async () => {
  const app = await buildApp();
  const ownerUserId = "toolbox-user-context-pack";
  const agentId = "shifu-u-context-pack-owner";

  const response = await app.request("/api/provisioning/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId,
      name: "Context Pack Owner Agent",
      ownerUserId,
      settings: {},
    }),
  });

  expect(response.status).toBe(201);

  const { createPostgresAgentConfigStore } = await import(
    "../stores/postgres-stores.js"
  );
  const { getWorkspaceRole } = await import("../../utils/organization-access.js");
  const { getDb } = await import("../../db/client.js");

  const store = createPostgresAgentConfigStore();
  const metadata = await orgContext.run({ organizationId: ORG_ID }, () =>
    store.getMetadata(agentId),
  );
  const role = await getWorkspaceRole(getDb(), ORG_ID, ownerUserId);

  expect(metadata).toMatchObject({
    agentId,
    owner: { platform: "toolbox", userId: ownerUserId },
    organizationId: ORG_ID,
  });
  expect(role).toBe("member");
});
```

- [ ] **Step 3: Run memory and provisioning route tests together**

Run:

```bash
bun test \
  packages/server/src/lobu/__tests__/provisioning-routes.test.ts \
  packages/server/src/lobu/__tests__/memory-routes.test.ts
```

Expected: PASS. This ensures strict memory-route behavior still holds while provisioning now satisfies it.

- [ ] **Step 4: Commit Task 3**

Run:

```bash
git add packages/server/src/lobu/__tests__/memory-routes.test.ts packages/server/src/lobu/__tests__/provisioning-routes.test.ts
git commit -m "test: lock memory membership boundary"
```

---

### Task 4: Backfill / Repair Script and Documentation

**Files:**
- Create: `packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs`
- Modify: `docs/plans/personal-agent-membership-provisioning.md`
- Test: run script in dry-run mode against available environment when `DATABASE_URL` exists; otherwise run syntax check.

- [ ] **Step 1: Create the repair script**

Create `packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs`:

```js
#!/usr/bin/env node
import crypto from "node:crypto";
import postgres from "postgres";

function usage() {
  return [
    "Usage: DATABASE_URL=... node packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs [--apply] [--limit N]",
    "",
    "Dry-run is the default. The script prints counts and agent ids only.",
  ].join("\\n");
}

function parseArgs(argv) {
  const args = { apply: false, limit: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
        throw new Error("--limit must be an integer from 1 to 10000");
      }
      args.limit = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function memberId(organizationId, ownerUserId) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId]))
    .digest("hex")
    .slice(0, 24);
  return `member_${digest}`;
}

const args = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const rows = await sql`
    SELECT a.id AS agent_id, a.organization_id, a.owner_user_id
    FROM agents a
    LEFT JOIN "member" m
      ON m."organizationId" = a.organization_id
     AND m."userId" = a.owner_user_id
    WHERE a.id LIKE 'shifu-u-%'
      AND a.owner_platform = 'toolbox'
      AND a.owner_user_id IS NOT NULL
      AND a.owner_user_id <> ''
      AND m.id IS NULL
    ORDER BY a.updated_at DESC NULLS LAST, a.id ASC
    LIMIT ${args.limit}
  `;

  console.log(JSON.stringify({
    mode: args.apply ? "apply" : "dry-run",
    missingMembershipCount: rows.length,
    agents: rows.map((row) => row.agent_id),
  }, null, 2));

  if (args.apply && rows.length > 0) {
    await sql.begin(async (tx) => {
      for (const row of rows) {
        await tx`
          INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
          VALUES (
            ${memberId(row.organization_id, row.owner_user_id)},
            ${row.organization_id},
            ${row.owner_user_id},
            'member',
            NOW()
          )
          ON CONFLICT ("organizationId", "userId") DO NOTHING
        `;
      }
    });
    console.log(JSON.stringify({ repairedCount: rows.length }, null, 2));
  }
} finally {
  await sql.end({ timeout: 5 });
}
```

- [ ] **Step 2: Run syntax check**

Run:

```bash
node --check packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs
```

Expected: no syntax errors.

- [ ] **Step 3: Run dry-run if `DATABASE_URL` is available**

Run:

```bash
if [ -n "${DATABASE_URL:-}" ]; then
  node packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs --limit 20
else
  echo "DATABASE_URL not set; skipped live dry-run"
fi
```

Expected: either sanitized JSON output with `mode: "dry-run"` or the skip message. It must not print the database URL.

- [ ] **Step 4: Update the spec implementation note**

Append to `docs/plans/personal-agent-membership-provisioning.md` after "Backfill Contract":

```md
Implementation note:

- Provisioning-time repair lives in `packages/server/src/lobu/provisioning-routes.ts`.
- Offline repair is available through `packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs`.
- The repair script defaults to dry-run and prints only counts plus agent ids.
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test \
  packages/server/src/lobu/__tests__/provisioning-routes.test.ts \
  packages/server/src/lobu/__tests__/memory-routes.test.ts
node --check packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs
```

Expected: tests pass and syntax check passes.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs docs/plans/personal-agent-membership-provisioning.md
git commit -m "chore: add toolbox personal agent membership repair"
```

---

### Task 5: Final Verification and Handoff

**Files:**
- No required code files.
- May update `docs/plans/personal-agent-membership-provisioning-implementation.md` checkboxes if the executor is tracking progress in-file.

- [ ] **Step 1: Run all focused tests**

Run:

```bash
bun test \
  packages/server/src/lobu/__tests__/provisioning-routes.test.ts \
  packages/server/src/lobu/__tests__/memory-routes.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broad server type/build check if available**

Run:

```bash
bun run typecheck
```

Expected: PASS. If this is too broad or blocked by unrelated pre-existing errors, capture the exact failing command and error summary, then run the narrower package check recommended by `AGENTS.md`:

```bash
make build-packages
```

- [ ] **Step 3: Inspect diff for secret leakage**

Run:

```bash
git diff shifu/main...HEAD -- packages/server/src/lobu packages/server/scripts docs/plans | rg -n "DATABASE_URL=|Bearer |TOKEN|SECRET|password|credential" || true
```

Expected: no actual secret values. Placeholder words in docs or code comments are acceptable only when they do not reveal values.

- [ ] **Step 4: Confirm commit history**

Run:

```bash
git log --oneline shifu/main..HEAD
git status --short --branch
```

Expected: commits are on `codex/personal-agent-membership-provisioning-spec`; worktree is clean.

- [ ] **Step 5: Handoff summary**

Prepare a concise summary with:

- changed files;
- tests run;
- whether broad checks passed or were blocked;
- why `/memory/context-packs` stayed strict;
- deployment note: Lobu runtime must still go through GitHub Actions image build -> GHCR -> Zeabur image service, no local source deploy.

