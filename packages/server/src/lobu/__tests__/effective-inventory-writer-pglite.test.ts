import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalize } from "json-canonicalize";
import { generateWorkerToken } from "@lobu/core";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutionEventRoutes } from "../../gateway/routes/internal/execution-events";
import {
  createPostgresEffectiveToolInventoryStore,
  createProvisioningRoutes,
  createReleaseAssuranceReadback,
} from "../provisioning-routes";
import { orgContext } from "../stores/org-context";

const ORG = "org-writer";
const AGENT = "shifu-u-writer";
const CAP = `sha256:${"a".repeat(64)}`;
const previousKey = process.env.ENCRYPTION_KEY;
let pg: PGlite;
let app: Hono;

describe("worker effective inventory writer to public release readback", () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    pg = new PGlite();
    await pg.exec(`CREATE TABLE agents (organization_id text,id text,PRIMARY KEY(organization_id,id));
      CREATE TABLE public.agent_release_applies (organization_id text,agent_id text,
        applied_release_id text,applied_release_sequence bigint,status text);`);
    for (const file of [
      "20260627120000_execution_observability.sql",
      "20260715020000_agent_effective_tool_inventory_snapshots.sql",
      "20260715030000_agent_release_capability_snapshots.sql",
    ]) {
      const source = readFileSync(
        path.resolve(__dirname, `../../../../../db/migrations/${file}`),
        "utf8",
      );
      await pg.exec(
        source.split("-- migrate:down")[0]!.replace("-- migrate:up", ""),
      );
    }
    await pg.query("INSERT INTO agents VALUES($1,$2)", [ORG, AGENT]);
    await pg.query(
      "INSERT INTO public.agent_release_applies VALUES($1,$2,'release-1',1,'applied')",
      [ORG, AGENT],
    );
    await pg.query(
      `INSERT INTO public.agent_release_capability_snapshots VALUES
      ($1,$2,'release-1',1,$3,'["cap.v1"]',now(),now()+interval '1 hour')`,
      [ORG, AGENT, CAP],
    );
    const sql = tagged(pg);
    const inventoryStore = createPostgresEffectiveToolInventoryStore(sql);
    const readback = createReleaseAssuranceReadback({
      sql,
      inventoryStore,
      findAgentBase: async ({ organizationId, agentId }) =>
        organizationId === ORG && agentId === AGENT
          ? {
              managedReleaseReceipt: { status: "applied" },
              liveManagedSettingsDigest: CAP,
            }
          : null,
    });
    app = new Hono();
    app.use("/api/provisioning/*", async (c, next) => {
      c.set("user", { id: "admin" });
      c.set("session", { id: "pat:test" });
      c.set("organizationId", ORG);
      c.set("authSource", "pat");
      c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
      return orgContext.run({ organizationId: ORG }, next);
    });
    app.route(
      "/",
      createExecutionEventRoutes({
        sql,
      }),
    );
    app.route(
      "/api/provisioning",
      createProvisioningRoutes({ releaseAssuranceReadback: readback }),
    );
  });
  afterAll(async () => {
    await pg.close();
    if (previousKey) process.env.ENCRYPTION_KEY = previousKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  it("binds token authority, full-replaces names, rejects wrong scope, and expires", async () => {
    const expiresAt = new Date(Date.now() + 800).toISOString();
    await write(workerToken(ORG, "release-1", 1, expiresAt), "exec:first", [
      "kept",
      "removed",
    ]);
    await write(workerToken(ORG, "release-1", 1, expiresAt), "exec:authority", [
      "kept",
    ]);
    await write(workerToken(ORG, "release-1", 1, expiresAt), "exec:authority", [
      "kept",
    ]);
    expect(await inventory()).toMatchObject({
      status: "available",
      names: ["kept"],
      releaseId: "release-1",
      capabilitySnapshotDigest: CAP,
    });

    await write(
      workerToken(ORG, "release-1", 1, expiresAt),
      "exec:authority",
      ["changed"],
      409,
    );
    await write(
      workerToken(ORG, "release-2", 2, expiresAt),
      "exec:wrong-release",
      ["wrong_release"],
      409,
    );
    await write(
      workerToken("org-other", "release-1", 1, expiresAt),
      "exec:wrong-org",
      ["wrong_org"],
      409,
    );
    await write(
      workerToken(ORG, "release-1", 1, expiresAt),
      "exec:bad-fingerprint",
      ["bad"],
      409,
      "f".repeat(64),
    );
    const partial = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.execution_tasks WHERE id='exec:bad-fingerprint'",
    );
    expect(partial.rows[0]?.count).toBe(0);
    expect(await inventory()).toMatchObject({
      status: "available",
      names: ["kept"],
    });
    const replayCount = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.execution_tasks WHERE id='exec:authority'",
    );
    expect(replayCount.rows[0]?.count).toBe(1);
    await pg.query(
      "UPDATE public.agent_effective_tool_inventory_snapshots SET inventory_fingerprint=$1 WHERE snapshot_authority='exec:authority'",
      [`sha256:${"e".repeat(64)}`],
    );
    expect(await inventory()).toMatchObject({ status: "missing", names: [] });
    await pg.query(
      "UPDATE public.agent_effective_tool_inventory_snapshots SET inventory_fingerprint=$1 WHERE snapshot_authority='exec:authority'",
      [inventoryFingerprint(["kept"])],
    );
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(await inventory()).toMatchObject({ status: "missing", names: [] });
  });
});

async function write(
  token: string,
  taskId: string,
  names: string[],
  expectedStatus = 200,
  fingerprint = inventoryFingerprint(names).slice("sha256:".length),
) {
  const response = await app.request("/internal/execution-events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "create",
      taskId,
      agentId: AGENT,
      conversationId: "conversation-1",
      userId: "user-1",
      metadata: {
        effectiveToolInventory: { names, fingerprint },
      },
    }),
  });
  expect(response.status).toBe(expectedStatus);
}
async function inventory() {
  const response = await app.request(
    `/api/provisioning/agents/${AGENT}/release-assurance`,
  );
  expect(response.status).toBe(200);
  return (await response.json()).effectiveMcpToolInventory;
}
function workerToken(
  organizationId: string,
  releaseId: string,
  releaseSequence: number,
  expiresAt: string,
) {
  return generateWorkerToken("user-1", "conversation-1", "deploy-1", {
    channelId: "line:U1",
    agentId: AGENT,
    organizationId,
    tokenKind: "run",
    runId: 1,
    releaseState: {
      status: "active",
      claim: {
        environment: "production",
        toolboxUserId: "user-1",
        agentId: AGENT,
        releaseId,
        releaseSequence,
        snapshotDigest: CAP,
        expiresAt,
        capabilityIds: ["cap.v1"],
      },
    },
  });
}
function tagged(db: PGlite) {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index++)
      text += `$${index + 1}${strings[index + 1] ?? ""}`;
    return (
      await db.query(
        text,
        values.map((value) =>
          Array.isArray(value) ? JSON.stringify(value) : value,
        ) as never[],
      )
    ).rows;
  }) as any;
  sql.json = (value: unknown) => JSON.stringify(value);
  sql.begin = async (fn: (tx: ReturnType<typeof tagged>) => Promise<unknown>) =>
    db.transaction(async (tx) => fn(tagged(tx as unknown as PGlite)));
  return sql;
}

function inventoryFingerprint(names: string[]) {
  const canonical = [...new Set(names.map((name) => name.trim()))].sort();
  return `sha256:${createHash("sha256").update(canonicalize(canonical)).digest("hex")}`;
}
