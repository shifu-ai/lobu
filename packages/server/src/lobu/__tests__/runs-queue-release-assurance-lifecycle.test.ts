import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunsQueue } from "../../gateway/infrastructure/queue/runs-queue";
import type {
  QueueConsumerHeartbeat,
  QueueConsumerLeaseFact,
  QueueConsumerLeaseStore,
} from "../../gateway/infrastructure/queue/queue-consumer-lease";
import {
  createProvisioningRoutes,
  createReleaseAssuranceReadback,
} from "../provisioning-routes";
import { orgContext } from "../stores/org-context";

const DIGEST = `sha256:${"a".repeat(64)}`;
const original = {
  environment: process.env.ENVIRONMENT,
  revision: process.env.APP_GIT_SHA,
  digest: process.env.APP_DECLARED_IMAGE_DIGEST,
  buildTime: process.env.APP_BUILD_TIME,
};

describe("RunsQueue observable lease lifecycle", () => {
  let clock: FakeLeaseClock;
  let store: MemoryLeaseStore;
  const queues: RunsQueue[] = [];
  beforeEach(() => {
    process.env.ENVIRONMENT = "production";
    process.env.APP_GIT_SHA = "a".repeat(40);
    process.env.APP_DECLARED_IMAGE_DIGEST = DIGEST;
    process.env.APP_BUILD_TIME = "2026-07-15T10:00:00.000Z";
    clock = new FakeLeaseClock(new Date("2026-07-15T10:00:00.000Z"));
    store = new MemoryLeaseStore();
  });
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((queue) => queue.stop()));
    assignEnv("ENVIRONMENT", original.environment);
    assignEnv("APP_GIT_SHA", original.revision);
    assignEnv("APP_DECLARED_IMAGE_DIGEST", original.digest);
    assignEnv("APP_BUILD_TIME", original.buildTime);
  });

  it("publishes no active lease while paused, registers on resume, and expires on pause", async () => {
    const queue = await queueFor("replica-a");
    await queue.work("messages", async () => undefined, { startPaused: true });
    expect((await inspect()).queueConsumer.activeConsumerCount).toBe(0);
    await queue.resumeWorker("messages");
    expect((await inspect()).queueConsumer).toMatchObject({
      activeConsumerCount: 1,
      consumers: [
        expect.objectContaining({
          queueName: "messages",
          consumerId: "replica-a",
        }),
      ],
    });
    clock.advance(30_000);
    await clock.tickIntervals();
    expect(store.facts()[0]!.lastSeenAt).toBe("2026-07-15T10:00:30.000Z");
    await queue.pauseWorker("messages");
    clock.advance(2);
    expect((await inspect()).queueConsumer).toMatchObject({
      activeConsumerCount: 0,
      reasonCodes: expect.arrayContaining(["consumer_stale"]),
    });
  });

  it("keeps distinct homogeneous replicas observable without a carrier mismatch", async () => {
    const first = await queueFor("replica-a");
    const second = await queueFor("replica-b");
    await first.work("messages", async () => undefined);
    await second.work("messages", async () => undefined);
    const queueConsumer = (await inspect()).queueConsumer;
    expect(queueConsumer.activeConsumerCount).toBe(2);
    expect(queueConsumer.reasonCodes).not.toContain(
      "consumer_carrier_mismatch"
    );
    expect(queueConsumer.reasonCodes).not.toContain(
      "consumer_runtime_mismatch"
    );
  });

  it.each([
    "pause",
    "stop",
  ] as const)("serializes %s expiry after an in-flight heartbeat", async (action) => {
    const queue = await queueFor("replica-race");
    await queue.work("messages", async () => undefined);
    const release = store.blockNextHeartbeat();
    clock.advance(30_000);
    const heartbeat = clock.tickIntervals();
    await Promise.resolve();
    const deactivation =
      action === "pause" ? queue.pauseWorker("messages") : queue.stop();
    release();
    await Promise.all([heartbeat, deactivation]);
    clock.advance(2);
    expect((await inspect()).queueConsumer.activeConsumerCount).toBe(0);
  });

  it("expires an active lease when replaced by a startPaused worker", async () => {
    const queue = await queueFor("replica-replaced");
    await queue.work("messages", async () => undefined);
    await queue.work("messages", async () => undefined, { startPaused: true });
    clock.advance(2);
    expect((await inspect()).queueConsumer.activeConsumerCount).toBe(0);
  });

  it("reports duplicate active lease instances under one consumer identity", async () => {
    const first = await queueFor("replica-duplicate");
    const second = await queueFor("replica-duplicate");
    await first.work("messages", async () => undefined);
    await second.work("messages", async () => undefined);
    expect((await inspect()).queueConsumer.reasonCodes).toContain(
      "consumer_identity_conflict"
    );
  });

  async function queueFor(consumerId: string) {
    const queue = new RunsQueue({
      database: () => emptyDb(),
      listener: () =>
        ({
          listen: async () => ({
            unlisten: async () => undefined,
          }),
        }) as never,
      leaseStore: store,
      consumerId,
      leaseClock: clock,
    });
    queues.push(queue);
    await queue.start();
    return queue;
  }
  async function inspect() {
    const readback = createReleaseAssuranceReadback({
      sql: emptyDb(),
      leaseStore: store,
      now: () => clock.now(),
      findAgentBase: async () => null,
    });
    const app = authenticatedApp(readback);
    const response = await app.request("/api/provisioning/release-assurance");
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  }
});

class MemoryLeaseStore implements QueueConsumerLeaseStore {
  private readonly values = new Map<string, QueueConsumerLeaseFact>();
  private nextHeartbeatGate: Promise<void> | null = null;
  blockNextHeartbeat() {
    let release!: () => void;
    this.nextHeartbeatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }
  async heartbeat(input: QueueConsumerHeartbeat) {
    const gate = this.nextHeartbeatGate;
    this.nextHeartbeatGate = null;
    if (gate) await gate;
    const key = `${input.queueName}:${input.consumerId}:${input.leaseInstanceId}`;
    const existing = this.values.get(key);
    this.values.set(key, {
      queueName: input.queueName,
      consumerId: input.consumerId,
      leaseInstanceId: input.leaseInstanceId,
      deploymentRevision: input.deploymentRevision,
      declaredImageDigest: input.declaredImageDigest,
      startedAt: input.startedAt.toISOString(),
      lastSeenAt: input.now.toISOString(),
      leaseExpiresAt: new Date(input.now.getTime() + 90_000).toISOString(),
      identityConflict:
        existing?.identityConflict === true ||
        Boolean(
          existing &&
            (existing.deploymentRevision !== input.deploymentRevision ||
              existing.declaredImageDigest !== input.declaredImageDigest)
        ),
    });
  }
  async expire(
    queueName: string,
    consumerId: string,
    leaseInstanceId: string,
    now: Date
  ) {
    const key = `${queueName}:${consumerId}:${leaseInstanceId}`;
    const value = this.values.get(key);
    if (value)
      this.values.set(key, {
        ...value,
        lastSeenAt: now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + 1).toISOString(),
      });
  }
  async list(requiredQueues: readonly string[]) {
    return this.facts().filter((fact) =>
      requiredQueues.includes(fact.queueName)
    );
  }
  facts() {
    return [...this.values.values()];
  }
}

class FakeLeaseClock {
  private callbacks = new Set<() => void>();
  constructor(private value: Date) {}
  now = () => new Date(this.value);
  setInterval = (callback: () => void, _ms: number) => {
    this.callbacks.add(callback);
    return callback as never;
  };
  clearInterval = (timer: ReturnType<typeof setInterval>) => {
    this.callbacks.delete(timer as never);
  };
  advance(ms: number) {
    this.value = new Date(this.value.getTime() + ms);
  }
  async tickIntervals() {
    await Promise.all([...this.callbacks].map((callback) => callback()));
  }
}

function emptyDb() {
  const rows: any[] = [];
  Object.defineProperty(rows, "count", { value: 0 });
  const sql = (async () => rows) as any;
  sql.unsafe = async () => rows;
  sql.json = (value: unknown) => value;
  return sql;
}
function authenticatedApp(
  readback: ReturnType<typeof createReleaseAssuranceReadback>
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user" });
    c.set("session", { id: "pat:test" });
    c.set("organizationId", "org");
    c.set("authSource", "pat");
    c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
    return orgContext.run({ organizationId: "org" }, next);
  });
  app.route(
    "/api/provisioning",
    createProvisioningRoutes({ releaseAssuranceReadback: readback })
  );
  return app;
}
function assignEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
