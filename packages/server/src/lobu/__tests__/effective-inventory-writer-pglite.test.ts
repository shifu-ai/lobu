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
let controlledReadNow: Date;
let controlledWriteNow: Date;

describe("worker effective inventory writer to public release readback", () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    controlledReadNow = new Date();
    controlledWriteNow = controlledReadNow;
    pg = new PGlite();
    await pg.exec(`CREATE TABLE agents (organization_id text,id text,PRIMARY KEY(organization_id,id));
      CREATE TABLE public.agent_release_applies (organization_id text,agent_id text,
        desired_release_id text, desired_release_sequence bigint, desired_feed_sequence bigint,
        applied_release_id text, applied_release_sequence bigint, applied_feed_sequence bigint, status text);`);
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
      "INSERT INTO public.agent_release_applies VALUES($1,$2,'release-1',1,7,'release-1',1,7,'applied')",
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
      now: () => controlledReadNow,
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
        now: () => controlledWriteNow,
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
    const expires = await pg.query<{ expires_at: Date | string }>(
      "SELECT expires_at FROM public.agent_effective_tool_inventory_snapshots WHERE snapshot_authority='exec:authority'",
    );
    expect(expires.rows).toHaveLength(1);
    const inventoryExpiresAt = expires.rows[0]?.expires_at;
    if (!inventoryExpiresAt) throw new Error("inventory expiry not recorded");
    const inventoryExpiresAtMs =
      inventoryExpiresAt instanceof Date
        ? inventoryExpiresAt.getTime()
        : Date.parse(inventoryExpiresAt);
    expect(
      await inventory(new Date(inventoryExpiresAtMs + 1)),
    ).toMatchObject({ status: "missing", names: [] });
  });

  it("keeps inventory evidence fresh after the 60 second CAP lease expires", async () => {
    const base = new Date(Date.now());
    const beforeClaimObservedAt = new Date(base.getTime() + 10_000);
    const claimObservedAt = new Date(base.getTime() + 60_000);
    const claimExpiresAt = new Date(base.getTime() + 70_000);

    await pg.query(
      "UPDATE public.agent_release_capability_snapshots SET observed_at=$1, expires_at=$2 WHERE organization_id=$3 AND agent_id=$4",
      [
        claimObservedAt.toISOString(),
        claimExpiresAt.toISOString(),
        ORG,
        AGENT,
      ],
    );

    await write(
      workerToken(ORG, "release-1", 1, claimExpiresAt.toISOString()),
      "exec:before-cap-observed",
      ["too-early"],
      409,
      inventoryFingerprint(["too-early"]).slice("sha256:".length),
      beforeClaimObservedAt,
    );
    const rejected = await pg.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.agent_effective_tool_inventory_snapshots WHERE snapshot_authority='exec:before-cap-observed'",
    );
    expect(rejected.rows[0]?.count).toBe(0);

    const activeClaimObservedAt = base;
    const activeClaimExpiresAt = new Date(base.getTime() + 60_000);
    const inventoryObservedAt = new Date(base.getTime() + 10_000);
    const readbackAt = new Date(base.getTime() + 70_000);
    const inventoryExpiresAt = new Date(base.getTime() + 310_000);

    await pg.query(
      "UPDATE public.agent_release_capability_snapshots SET observed_at=$1, expires_at=$2 WHERE organization_id=$3 AND agent_id=$4",
      [
        activeClaimObservedAt.toISOString(),
        activeClaimExpiresAt.toISOString(),
        ORG,
        AGENT,
      ],
    );

    await write(
      workerToken(ORG, "release-1", 1, activeClaimExpiresAt.toISOString()),
      "exec:historical-cap",
      ["kept"],
      200,
      inventoryFingerprint(["kept"]).slice("sha256:".length),
      inventoryObservedAt,
    );

    expect(await inventory(readbackAt)).toMatchObject({
      status: "available",
      names: ["kept"],
      releaseId: "release-1",
      capabilitySnapshotDigest: CAP,
      observedAt: inventoryObservedAt.toISOString(),
      expiresAt: inventoryExpiresAt.toISOString(),
    });
  });

  it("rejects inventory observed at or after CAP expiry without writing partial state", async () => {
    const base = new Date(Date.now() + 30_000);
    const capExpiresAt = new Date(base.getTime() + 60_000);

    await pg.query(
      "UPDATE public.agent_release_capability_snapshots SET observed_at=$1, expires_at=$2 WHERE organization_id=$3 AND agent_id=$4",
      [base.toISOString(), capExpiresAt.toISOString(), ORG, AGENT],
    );

    for (const [taskId, observedAt] of [
      ["exec:cap-expiry-bound", capExpiresAt],
      ["exec:after-cap-expiry", new Date(capExpiresAt.getTime() + 1)],
    ] as const) {
      await write(
        workerToken(ORG, "release-1", 1, capExpiresAt.toISOString()),
        taskId,
        ["too-late"],
        409,
        inventoryFingerprint(["too-late"]).slice("sha256:".length),
        observedAt,
      );
    }

    const partial = await pg.query<{ tasks: number; inventories: number }>(
      `SELECT
        (SELECT count(*)::int FROM public.execution_tasks WHERE id IN ('exec:cap-expiry-bound','exec:after-cap-expiry')) AS tasks,
        (SELECT count(*)::int FROM public.agent_effective_tool_inventory_snapshots
          WHERE snapshot_authority IN ('exec:cap-expiry-bound','exec:after-cap-expiry')) AS inventories`,
    );
    expect(partial.rows[0]).toEqual({ tasks: 0, inventories: 0 });
  });

  it("keeps inventory evidence TTL writer-owned when request metadata asks for a longer TTL", async () => {
    const observedAt = new Date(Date.now() + 20_000);
    const capExpiresAt = new Date(observedAt.getTime() + 60_000);
    const requestedExpiresAt = new Date(observedAt.getTime() + 60 * 60_000);

    await pg.query(
      "UPDATE public.agent_release_capability_snapshots SET observed_at=$1, expires_at=$2 WHERE organization_id=$3 AND agent_id=$4",
      [
        observedAt.toISOString(),
        capExpiresAt.toISOString(),
        ORG,
        AGENT,
      ],
    );

    await write(
      workerToken(ORG, "release-1", 1, capExpiresAt.toISOString()),
      "exec:request-ttl-extension",
      ["kept"],
      200,
      inventoryFingerprint(["kept"]).slice("sha256:".length),
      observedAt,
      {
        expiresAt: requestedExpiresAt.toISOString(),
        ttlMs: 60 * 60_000,
        evidenceTtlMs: 60 * 60_000,
      },
    );

    const stored = await pg.query<{
      observed_at: Date | string;
      expires_at: Date | string;
    }>(
      "SELECT observed_at, expires_at FROM public.agent_effective_tool_inventory_snapshots WHERE snapshot_authority='exec:request-ttl-extension'",
    );
    expect(stored.rows).toHaveLength(1);
    expect(toIso(stored.rows[0]!.observed_at)).toBe(observedAt.toISOString());
    expect(toIso(stored.rows[0]!.expires_at)).toBe(
      new Date(observedAt.getTime() + 5 * 60_000).toISOString(),
    );
  });
});

async function write(
  token: string,
  taskId: string,
  names: string[],
  expectedStatus = 200,
  fingerprint = inventoryFingerprint(names).slice("sha256:".length),
  observedAt?: Date,
  metadata: Record<string, unknown> = {},
) {
  controlledWriteNow = observedAt ?? new Date();
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
        ...metadata,
        effectiveToolInventory: { names, fingerprint },
      },
    }),
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `expected status ${expectedStatus}, got ${response.status}: ${await response.text()}`,
    );
  }
}
async function inventory(now?: Date) {
  if (now) controlledReadNow = now;
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

function toIso(value: Date | string) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
