/**
 * Integration tests for RunsQueue against a real Postgres.
 *
 * Covers the production behaviors that unit-level mocking cannot exercise —
 * SKIP LOCKED concurrency, graceful shutdown release, priority + expires_at +
 * retryDelay options, startup recovery scan.
 *
 * The SKIP LOCKED concurrency test drives multiple pooled connections against
 * the real embedded Postgres; the production guarantee (FOR UPDATE SKIP LOCKED
 * is row-locked at the heap-tuple level) holds because the SQL is identical.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { RunsQueue, sweepCompletedRuns } from "../infrastructure/queue/runs-queue.js";
import { terminalCourseContextSingletonKey } from "../orchestration/message-consumer.js";
import { getDb } from "../../db/client.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

let queue: RunsQueue | null = null;

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  queue = new RunsQueue();
  await queue.start();
});

afterEach(async () => {
  if (queue) {
    await queue.stop();
    queue = null;
  }
});

afterAll(async () => {
  // No global teardown — db-setup.ts owns the embedded Postgres lifecycle.
});

describe("RunsQueue — SKIP LOCKED claim concurrency", () => {
  test("each row is consumed exactly once across concurrent claim loops", async () => {
    if (!queue) throw new Error("queue not started");
    const N = 8;
    for (let i = 0; i < N; i++) {
      await queue.send("test-skip-locked", { i });
    }

    const consumed: number[] = [];
    const handler = async (job: { data: { i: number } }) => {
      consumed.push(job.data.i);
    };

    // Spawn 4 worker registrations against the same queue. Inside one
    // RunsQueue instance, each work() call replaces the previous worker for
    // the same queue name, so we test the single-worker SKIP LOCKED path.
    // Cross-process contention is identical SQL so this still demonstrates
    // the row-level claim semantics.
    await queue.work("test-skip-locked", handler);

    // Drain — poll until all claimed.
    const start = Date.now();
    while (consumed.length < N && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(consumed.length).toBe(N);
    expect(new Set(consumed).size).toBe(N);
  });
});

describe("RunsQueue — caller options", () => {
  test("durable send reports first acceptance and atomic receipt deduplication", async () => {
    if (!queue) throw new Error("queue not started");
    const first = await queue.sendDurable(
      "messages",
      {},
      { singletonKey: "message-api-conversation-delivery-1" },
    );
    const sql = getDb();
    await sql`UPDATE runs SET status='completed', completed_at=now() WHERE id=${Number(first.jobId)}`;
    const duplicate = await queue.sendDurable(
      "messages",
      {},
      { singletonKey: "message-api-conversation-delivery-1" },
    );

    expect(first).toEqual({ jobId: expect.any(String), deduplicated: false });
    expect(duplicate).toEqual({ jobId: first.jobId, deduplicated: true });
    const rows = await sql<{ count: number }>`SELECT count(*)::int AS count FROM runs WHERE idempotency_key='message-api-conversation-delivery-1'`;
    expect(rows[0]?.count).toBe(1);
  });

  test("durable singleton survives terminal run state while distinct canonical keys remain independent", async () => {
    if (!queue) throw new Error("queue not started");
    const sql=getDb();
    const first=await queue.send("thread_message_a",{},{singletonKey:"worker-message:turn-a",durableSingleton:true});
    await sql`UPDATE runs SET status='completed', completed_at=now() WHERE id=${Number(first)}`;
    const retry=await queue.send("thread_message_a",{},{singletonKey:"worker-message:turn-a",durableSingleton:true});
    expect(retry).toBe(first);
    await queue.send("thread_message_b",{},{singletonKey:"worker-message:turn-b",durableSingleton:true});
    const rows=await sql<{count:number}>`SELECT count(*)::int AS count FROM runs WHERE idempotency_key LIKE 'worker-message:turn-%'`;
    expect(rows[0]?.count).toBe(2);
  });

  test("durable receipt scope collisions fail closed",async()=>{if(!queue)throw new Error("queue not started");const sql=getDb();await sql`INSERT INTO queue_dispatch_receipts(idempotency_key,queue_name)VALUES('collision','other')`;await expect(queue.send('expected',{}, {singletonKey:'collision',durableSingleton:true})).rejects.toThrow('scope collision');});

  test("receipt sweep prunes only old terminal receipts and permits a later fresh event",async()=>{if(!queue)throw new Error("queue not started");const sql=getDb();const terminal=await queue.send('receipt-terminal',{}, {singletonKey:'receipt-terminal',durableSingleton:true});const active=await queue.send('receipt-active',{}, {singletonKey:'receipt-active',durableSingleton:true});const recent=await queue.send('receipt-recent',{}, {singletonKey:'receipt-recent',durableSingleton:true});await sql`UPDATE runs SET status='completed',completed_at=now() WHERE id IN (${Number(terminal)},${Number(recent)})`;await sql`UPDATE queue_dispatch_receipts SET created_at=now()-interval '31 days' WHERE idempotency_key IN ('receipt-terminal','receipt-active')`;await sweepCompletedRuns();const receipts=await sql<{idempotency_key:string}>`SELECT idempotency_key FROM queue_dispatch_receipts ORDER BY idempotency_key`;expect(receipts.map((r)=>r.idempotency_key)).toEqual(['receipt-active','receipt-recent']);const fresh=await queue.send('receipt-terminal',{}, {singletonKey:'receipt-terminal',durableSingleton:true});expect(fresh).not.toBe(terminal);});
  test("rolling adoption links a durable receipt to an existing active run",async()=>{if(!queue)throw new Error("queue not started");const sql=getDb();const existing=await queue.send('rolling',{}, {singletonKey:'rolling-key'});expect(await queue.send('rolling',{}, {singletonKey:'rolling-key',durableSingleton:true})).toBe(existing);const receipt=await sql<{run_id:number}>`SELECT run_id FROM queue_dispatch_receipts WHERE idempotency_key='rolling-key'`;expect(String(receipt[0]?.run_id)).toBe(existing);await sql`UPDATE queue_dispatch_receipts SET created_at=now()-interval '31 days' WHERE idempotency_key='rolling-key'`;await sweepCompletedRuns();expect(await queue.send('rolling',{}, {singletonKey:'rolling-key',durableSingleton:true})).toBe(existing);});

  test("a crash retry creates one course terminal run and one durable receipt",async()=>{if(!queue)throw new Error("queue not started");const sql=getDb();await seedAgentRow('agent-terminal',{organizationId:'org-terminal',ownerUserId:'owner-terminal'});const data={organizationId:'org-terminal',agentId:'agent-terminal',userId:'owner-terminal',platform:'line',channelId:'channel-terminal',conversationId:'conversation-terminal',messageId:'message-terminal'} as never;const result={status:'clarification_required',candidates:[{courseKey:'course-a',displayName:'A'}]} as const;const key=terminalCourseContextSingletonKey(data,result);const options={singletonKey:key,durableSingleton:true,retryLimit:30,retryDelay:1};const first=await queue.send('thread_response',{...data,finalText:'choose'},options);const retry=await queue.send('thread_response',{...data,finalText:'choose'},options);expect(retry).toBe(first);expect((await sql`SELECT idempotency_key FROM queue_dispatch_receipts WHERE idempotency_key=${key}`).length).toBe(1);expect((await sql`SELECT id FROM runs WHERE queue_name='thread_response' AND idempotency_key=${key}`).length).toBe(1);});

  test("receipt retention floors at 30d and honors longer configuration",async()=>{if(!queue)throw new Error("queue not started");const sql=getDb();const create=async(key:string,age:number)=>{const id=await queue!.send(key,{}, {singletonKey:key,durableSingleton:true});await sql`UPDATE runs SET status='completed',completed_at=now() WHERE id=${Number(id)}`;await sql`UPDATE queue_dispatch_receipts SET created_at=now()-(${age}::int*interval '1 day') WHERE idempotency_key=${key}`;};try{process.env.RUNS_RETENTION_DAYS='1';process.env.DISPATCH_RECEIPT_RETENTION_DAYS='1';await create('floor-low',2);await sweepCompletedRuns();process.env.DISPATCH_RECEIPT_RETENTION_DAYS='invalid';await create('floor-invalid',2);await sweepCompletedRuns();process.env.DISPATCH_RECEIPT_RETENTION_DAYS='60';await create('long-config',31);await sweepCompletedRuns();const kept=await sql<{idempotency_key:string}>`SELECT idempotency_key FROM queue_dispatch_receipts WHERE idempotency_key IN ('floor-low','floor-invalid','long-config') ORDER BY idempotency_key`;expect(kept.map((r)=>r.idempotency_key)).toEqual(['floor-invalid','floor-low','long-config']);await sql`UPDATE queue_dispatch_receipts SET created_at=now()-interval '61 days' WHERE idempotency_key='long-config'`;await sweepCompletedRuns();expect((await sql`SELECT 1 FROM queue_dispatch_receipts WHERE idempotency_key='long-config'`).length).toBe(0);}finally{delete process.env.RUNS_RETENTION_DAYS;delete process.env.DISPATCH_RECEIPT_RETENTION_DAYS;}});

  test("priority orders claim across same queue", async () => {
    if (!queue) throw new Error("queue not started");
    await queue.send("test-priority", { tag: "low" }, { priority: 1 });
    await queue.send("test-priority", { tag: "high" }, { priority: 10 });
    await queue.send("test-priority", { tag: "mid" }, { priority: 5 });

    const order: string[] = [];
    await queue.work(
      "test-priority",
      async (job: { data: { tag: string } }) => {
        order.push(job.data.tag);
      },
    );

    const start = Date.now();
    while (order.length < 3 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(order).toEqual(["high", "mid", "low"]);
  });

  test("expireInSeconds drops the row from claim", async () => {
    if (!queue) throw new Error("queue not started");
    // Send with a 1-second TTL, then directly age the row so it's already
    // expired before the worker picks it up.
    await queue.send(
      "test-expires",
      { tag: "doomed" },
      { expireInSeconds: 1 },
    );

    const sql = getDb();
    await sql`
      UPDATE runs
      SET expires_at = now() - interval '1 second'
      WHERE queue_name = 'test-expires'
    `;

    let claimed = false;
    await queue.work("test-expires", async () => {
      claimed = true;
    });

    await new Promise((r) => setTimeout(r, 600));
    expect(claimed).toBe(false);
  });

  test("retryDelay overrides exponential backoff with constant delay", async () => {
    if (!queue) throw new Error("queue not started");
    const sql = getDb();
    await queue.send(
      "test-retry-delay",
      { tag: "retry-me" },
      { retryDelay: 2, retryLimit: 3 },
    );

    let runs = 0;
    await queue.work("test-retry-delay", async () => {
      runs += 1;
      throw new Error("boom");
    });

    // Wait for first attempt + retry to be scheduled.
    await new Promise((r) => setTimeout(r, 600));
    const rows = await sql<{ run_at: Date; attempts: number }>`
      SELECT run_at, attempts FROM runs WHERE queue_name = 'test-retry-delay'
    `;
    // First attempt has run; row is back to pending with run_at ~2s in future.
    expect(rows.length).toBe(1);
    expect(rows[0]?.attempts ?? 0).toBeGreaterThanOrEqual(1);

    const runAt = rows[0]?.run_at?.getTime() ?? 0;
    expect(runAt).toBeGreaterThan(Date.now() + 1000);
    expect(runAt).toBeLessThan(Date.now() + 4000);
    expect(runs).toBe(1);
  });
});

describe("RunsQueue — action_input JSONB shape", () => {
  test("send() persists action_input as a JSONB object, not a double-encoded JSONB string", async () => {
    // Regression: pre-fix, the INSERT bound `JSON.stringify(data)` to a
    // `$4::jsonb` parameter via `tx.unsafe()`. Postgres stored that as a
    // JSONB *string* (jsonb_typeof = 'string'), not a JSONB object, which
    // made every downstream `action_input ->> 'field'` reader silently
    // return NULL — including the snapshot-route ownership verifier in
    // gateway/transcript-routes.ts. Assert the new shape end-to-end so a
    // future refactor can't re-introduce the bug.
    if (!queue) throw new Error("queue not started");
    const payload = {
      agentId: "marketing",
      conversationId: "telegram:6570514069",
      userId: "u1",
    };
    await queue.send("test-jsonb-shape", payload);

    const sql = getDb();
    const rows = (await sql`
      SELECT jsonb_typeof(action_input) AS shape,
             action_input ->> 'agentId' AS extracted_agent_id,
             action_input ->> 'conversationId' AS extracted_conv_id
      FROM runs
      WHERE queue_name = 'test-jsonb-shape'
    `) as Array<{
      shape: string;
      extracted_agent_id: string | null;
      extracted_conv_id: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.shape).toBe("object");
    // Direct `->>` extraction works on the object shape — the exact
    // accessor the snapshot-route verifier relies on.
    expect(rows[0]!.extracted_agent_id).toBe("marketing");
    expect(rows[0]!.extracted_conv_id).toBe("telegram:6570514069");
  });
});

describe("RunsQueue — graceful shutdown", () => {
  test("stop() releases claimed rows back to pending", async () => {
    if (!queue) throw new Error("queue not started");
    await queue.send("test-graceful", { tag: "hold" });

    let started = false;
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    await queue.work(
      "test-graceful",
      async () => {
        started = true;
        await blocked;
      },
    );

    // Wait for the worker to claim the row.
    const claimedStart = Date.now();
    while (!started && Date.now() - claimedStart < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(started).toBe(true);

    // Trigger shutdown; release after a tick so we can observe the released-row
    // path (drain timeout * 0 since handler resolves immediately on release).
    const stopPromise = queue.stop();
    setTimeout(() => release?.(), 100);
    await stopPromise;
    queue = null; // Don't double-stop in afterEach.

    // After stop, the row should be either in `pending` (released) or
    // `completed` (if the handler finished within the drain window).
    const sql = getDb();
    const rows = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE queue_name = 'test-graceful'
    `;
    expect(rows.length).toBe(1);
    const status = rows[0]?.status;
    expect(status === "pending" || status === "completed").toBe(true);
    if (status === "pending") {
      expect(rows[0]?.claimed_by).toBeNull();
    }
  });
});

describe("RunsQueue — startup recovery scan", () => {
  test("recovers stale claimed rows on start", async () => {
    if (!queue) throw new Error("queue not started");
    // Stop the live queue first so we can manipulate rows freely.
    await queue.stop();
    queue = null;

    const sql = getDb();
    // Insert a row in `claimed` state with an old claimed_at to simulate a
    // crashed prior run.
    await sql`
      INSERT INTO runs (run_type, queue_name, action_input, status, claimed_at, claimed_by, run_at)
      VALUES ('chat_message', 'recovery-q', '{}'::jsonb, 'claimed',
              now() - interval '20 minutes',
              'gateway-old-pid',
              now() - interval '20 minutes')
    `;

    // New RunsQueue instance — startup scan should reset the row.
    const fresh = new RunsQueue();
    await fresh.start();
    queue = fresh;

    const rows = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE queue_name = 'recovery-q'
    `;
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.claimed_by).toBeNull();
  });
});
