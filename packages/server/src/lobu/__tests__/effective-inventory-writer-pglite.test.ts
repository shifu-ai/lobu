import { readFileSync } from "node:fs";
import path from "node:path";
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
      "20260715020000_agent_effective_tool_inventory_snapshots.sql",
      "20260715030000_agent_release_capability_snapshots.sql",
    ]) {
      const source = readFileSync(
        path.resolve(__dirname, `../../../../../db/migrations/${file}`),
        "utf8"
      );
      await pg.exec(
        source.split("-- migrate:down")[0]!.replace("-- migrate:up", "")
      );
    }
    await pg.query("INSERT INTO agents VALUES($1,$2)", [ORG, AGENT]);
    await pg.query(
      "INSERT INTO public.agent_release_applies VALUES($1,$2,'release-1',1,'applied')",
      [ORG, AGENT]
    );
    await pg.query(
      `INSERT INTO public.agent_release_capability_snapshots VALUES
      ($1,$2,'release-1',1,$3,'["cap.v1"]',now(),now()+interval '1 hour')`,
      [ORG, AGENT, CAP]
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
        inventoryStore,
        createTask: async (input) => ({ id: input.id }) as never,
      })
    );
    app.route(
      "/api/provisioning",
      createProvisioningRoutes({ releaseAssuranceReadback: readback })
    );
  });
  afterAll(async () => {
    await pg.close();
    if (previousKey) process.env.ENCRYPTION_KEY = previousKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  it("binds token authority, full-replaces names, rejects wrong scope, and expires", async () => {
    const expiresAt = new Date(Date.now() + 800).toISOString();
    await write(workerToken(ORG, "release-1", 1, expiresAt), [
      "kept",
      "removed",
    ]);
    await write(workerToken(ORG, "release-1", 1, expiresAt), ["kept"]);
    expect(await inventory()).toMatchObject({
      status: "available",
      names: ["kept"],
      releaseId: "release-1",
      capabilitySnapshotDigest: CAP,
    });

    await write(workerToken(ORG, "release-2", 2, expiresAt), ["wrong_release"], 409);
    await write(workerToken("org-other", "release-1", 1, expiresAt), [
      "wrong_org",
    ], 409);
    expect(await inventory()).toMatchObject({
      status: "available",
      names: ["kept"],
    });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(await inventory()).toMatchObject({ status: "missing", names: [] });
  });
});

async function write(token: string, names: string[], expectedStatus = 200) {
  const response = await app.request("/internal/execution-events", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "create",
      taskId: "exec:authority",
      agentId: AGENT,
      conversationId: "conversation-1",
      userId: "user-1",
      metadata: {
        effectiveToolInventory: { names, fingerprint: "b".repeat(64) },
      },
    }),
  });
  expect(response.status).toBe(expectedStatus);
}
async function inventory() {
  const response = await app.request(
    `/api/provisioning/agents/${AGENT}/release-assurance`
  );
  expect(response.status).toBe(200);
  return (await response.json()).effectiveMcpToolInventory;
}
function workerToken(
  organizationId: string,
  releaseId: string,
  releaseSequence: number,
  expiresAt: string
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
          Array.isArray(value) ? JSON.stringify(value) : value
        ) as never[]
      )
    ).rows;
  }) as any;
  sql.json = (value: unknown) => JSON.stringify(value);
  return sql;
}
