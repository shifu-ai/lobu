/**
 * End-to-end tests for worker-response liveness signals. Drives the gateway's
 * POST /response handler the way a worker subprocess does and asserts the two
 * liveness clocks it must refresh: turn-liveness deadlines and deployment
 * activity.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { WorkerGateway } from "../gateway/index.js";
import { RunsQueue } from "../infrastructure/queue/runs-queue.js";
import { armTurnTimeout } from "../orchestration/turn-liveness.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012",
).toString("base64");

const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";
const DEPLOYMENT = "lobu-worker-agent-1";

let queue: RunsQueue;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await resetTestDatabase();
  await seedAgentRow("agent-1", { organizationId: "org-1" });
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  await queue.stop();
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

function makeGateway(): WorkerGateway {
  return new WorkerGateway(
    queue as never,
    "https://gateway.example.com",
    { getWorkerConfig: async () => ({ mcpServers: {} }) } as never,
    {
      getSessionContext: async () => ({
        agentInstructions: "",
        platformInstructions: "",
        networkInstructions: "",
        skillsInstructions: "",
        mcpStatus: [],
      }),
    } as never,
  );
}

function mintToken(): string {
  return generateWorkerToken("user-1", "conv-1", DEPLOYMENT, {
    channelId: "chan-1",
    agentId: "agent-1",
    organizationId: "org-1",
    connectionId: "connection-1",
    source: "watcher-run",
    runId: 1,
    messageId: "m1",
  });
}

function armLiveTurn(messageId = "m1"): Promise<void> {
  return armTurnTimeout(queue, {
    messageId,
    channelId: "chan-1",
    conversationId: "conv-1",
    userId: "user-1",
    platform: "api",
    deploymentName: DEPLOYMENT,
    organizationId: "org-1",
  });
}

async function postWorkerResponse(
  body: unknown,
  opts?: { tracker?: { updateDeploymentActivity: (d: string) => Promise<void> } },
): Promise<Response> {
  const gateway = makeGateway();
  if (opts?.tracker) gateway.setDeploymentActivityTracker(opts.tracker);
  try {
    return await gateway.getApp().request("/response", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintToken()}`,
        host: "gateway.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } finally {
    gateway.shutdown();
  }
}

async function markerRunAtMs(): Promise<number | null> {
  const rows = await getDb()<{ run_at: Date }>`
    SELECT run_at FROM public.runs
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}
      AND action_input->>'deploymentName' = ${DEPLOYMENT}
      AND action_input->>'messageId' = 'm1'
    LIMIT 1`;
  return rows[0] ? new Date(rows[0].run_at).getTime() : null;
}

async function expireMarker(): Promise<number> {
  await getDb()`
    UPDATE public.runs SET run_at = now() - interval '5 minutes'
    WHERE queue_name = ${TURN_TIMEOUT_QUEUE}`;
  const at = await markerRunAtMs();
  if (at === null) throw new Error("marker missing after expire");
  return at;
}

async function waitForDeadlineAfter(lapsedAt: number): Promise<number | null> {
  for (let i = 0; i < 50; i++) {
    const after = await markerRunAtMs();
    if (after !== null && after > lapsedAt + 1000) return after;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return markerRunAtMs();
}

describe("POST /response worker liveness deadline", () => {
  test("a status_update without received extends the turn deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();
    expect(lapsedAt).toBeLessThan(Date.now());

    const res = await postWorkerResponse({
      messageId: "m1",
      conversationId: "conv-1",
      statusUpdate: { elapsedSeconds: 40, state: "working" },
    });

    expect(res.status).toBe(200);
    const after = await waitForDeadlineAfter(lapsedAt);
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThan(Date.now());
    expect(after!).toBeGreaterThan(lapsedAt);
  });

  test("a delivery ACK still extends the turn deadline", async () => {
    await armLiveTurn("m1");
    const lapsedAt = await expireMarker();

    const res = await postWorkerResponse({ received: true, heartbeat: true });

    expect(res.status).toBe(200);
    const after = await waitForDeadlineAfter(lapsedAt);
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThan(Date.now());
  });
});

describe("POST /response deployment activity", () => {
  test("a status_update refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (deploymentName: string) => {
        touched.push(deploymentName);
      },
    };

    const res = await postWorkerResponse(
      {
        messageId: "m1",
        conversationId: "conv-1",
        statusUpdate: { elapsedSeconds: 40, state: "working" },
      },
      { tracker },
    );

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(touched).toContain(DEPLOYMENT);
  });

  test("a delivery ACK also refreshes the deployment activity tracker", async () => {
    await armLiveTurn("m1");
    const touched: string[] = [];
    const tracker = {
      updateDeploymentActivity: async (deploymentName: string) => {
        touched.push(deploymentName);
      },
    };

    const res = await postWorkerResponse(
      { received: true, heartbeat: true },
      { tracker },
    );

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(touched).toContain(DEPLOYMENT);
  });
});
