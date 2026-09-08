import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, writeFile, rm, readdir, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { generateWorkerToken } from "@lobu/core";
import { startEmbeddedBackend, type EmbeddedBackend } from "../../../__tests__/setup/embedded-postgres-backend";
import { closeDbSingleton, PROD_PG_VALUE_OPTIONS, type DbClient } from "../../../db/client";
import { SubagentStore } from "../store";
import { createSubagentParentDelivery } from "../parent-delivery";
import type { ISessionManager } from "../../session";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer";
import { dispatchSubagent, deliverSubagentCompletion } from "../dispatcher";
import type { SubagentScope } from "../types";
import { createSubagentRoutes } from "../routes";
import { createSubagentTools } from "../../../../../agent-worker/src/openclaw/subagent-tools";
import { CodexAuthStore } from "../codex-auth-store";
import { CodexCredentialStore } from "../codex-credentials";
import { Hono } from "hono";
import { createSubagentProvisioningRoutes } from "../provisioning-routes";
import { getSubagentParentCompletion } from "../parent-completion";
import { createCodexExecutor, prepareCodexAccount } from "../codex-executor";
import { SubagentArtifactStore } from "../artifacts";
import type { Env } from "../../../index";

let backend: EmbeddedBackend;
let sql: postgres.Sql;
let store: SubagentStore;
const scope: SubagentScope = {
  organizationId: "org-1", userId: "user-1", agentId: "agent-1",
  parentConversationId: "parent-1", parentRunId: "run-1",
};
let serial = 0;
const oldDatabaseUrl = process.env.DATABASE_URL;
const oldEncryptionKey = process.env.ENCRYPTION_KEY;
const input = () => ({ backend: "codex" as const, title: "整理課程資料", prompt: "整理提供的測試資料", idempotencyKey: `call-${++serial}` });

beforeAll(async () => {
  backend = await startEmbeddedBackend();
  process.env.DATABASE_URL = backend.url;
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  sql = postgres(backend.url, { max: 8, onnotice: () => {}, ...PROD_PG_VALUE_OPTIONS });
  await sql`CREATE TABLE agents (organization_id text, id text, owner_platform text DEFAULT 'toolbox', owner_user_id text DEFAULT 'user-1', PRIMARY KEY (organization_id, id))`;
  await sql`INSERT INTO agents (organization_id,id) VALUES ('org-1', 'agent-1')`;
  await sql`CREATE TABLE revoked_tokens (jti text PRIMARY KEY, expires_at timestamptz)`;
  await sql`CREATE TABLE runs (id bigint PRIMARY KEY, status text, queue_name text, action_input jsonb, organization_id text)`;
  await sql`CREATE TABLE execution_tasks (id text PRIMARY KEY, agent_id text, user_id text, conversation_id text, status text)`;
  const migration = await readFile(new URL("../../../../../../db/migrations/20260908000000_subagent_tasks.sql", import.meta.url), "utf8");
  await sql.unsafe(migration.split("-- migrate:down")[0]!);
  store = new SubagentStore(sql as unknown as DbClient);
}, 60_000);

afterAll(async () => {
  await closeDbSingleton(); await sql?.end(); await backend?.stop();
  if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDatabaseUrl;
  if (oldEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = oldEncryptionKey;
});

function token(userId = "user-1", active = true, tokenKind: "run" | "session" = "run", messageId = "parent-message") {
  return generateWorkerToken(userId, "parent-1", "deployment-1", {
    organizationId: "org-1", agentId: "agent-1", channelId: "api_user-1", runId: 100, messageId, tokenKind,
    releaseState: tokenKind === "session" ? undefined : active ? { status: "active", claim: {
      environment: "staging", toolboxUserId: userId, agentId: "agent-1", releaseId: "release-1",
      releaseSequence: 1, snapshotDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilityIds: ["agent.subagents.v1"],
    } } : { status: "legacy_unenrolled" },
  });
}

describe("子代理的持久化協作路徑", () => {
  test("真實 worker token API → database → executor → parent outbox", async () => {
    const app = createSubagentRoutes(store);
    const response = await app.request("/internal/subagents", {
      method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(202);
    const { task } = await response.json();
    const claim = (await store.claim(task.id))!;
    await dispatchSubagent(store, claim, { codex: async () => ({ summary: "課程摘要", artifacts: [] }) }, async () => true);
    const result = await app.request(`/internal/subagents/${task.id}`, { headers: { authorization: `Bearer ${token()}` } });
    expect((await result.json()).task.result.summary).toBe("課程摘要");
    const denied = await app.request(`/internal/subagents/${task.id}`, { headers: { authorization: `Bearer ${token("user-2")}` } });
    expect(denied.status).toBe(404);
    const deliveries: string[] = [];
    await deliverSubagentCompletion(store, task.id, async (delivery) => { deliveries.push(delivery.parentConversationId); });
    expect(deliveries).toEqual(["parent-1"]);
  });

  test("完成通知經實際 enqueue 回到原對話，拒絕入隊前 session 被替換", async () => {
    const parent = { ...scope, conversationId: scope.parentConversationId,
      messageId: "parent-enqueue-message" };
    await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
      VALUES (910001,'completed','message',${sql.json(parent)},'org-1')`;
    const task = await store.spawn({ ...scope, parentRunId: "910001" }, input());
    const claim = (await store.claim(task.id))!;
    await dispatchSubagent(store, claim, {
      codex: async () => ({ summary: "UNTRUSTED_CHILD_RESULT", artifacts: [] }),
    }, async () => true);
    const session = { agentId: scope.agentId, userId: scope.userId,
      organizationId: scope.organizationId, conversationId: scope.parentConversationId };
    let replaced = false;
    let touches = 0;
    type EnqueueArgs = Parameters<QueueProducer["enqueueMessage"]>;
    const enqueued: Array<{ payload: EnqueueArgs[0]; options: EnqueueArgs[1] }> = [];
    const deliver = createSubagentParentDelivery({ sql: sql as unknown as DbClient,
      sessionManager: {
        getSessionStrict: async () => session,
        getSession: async () => replaced ? { ...session, userId: "other-user" } : session,
        touchSession: async () => { touches++; },
      } as unknown as ISessionManager,
      queueProducer: { enqueueMessage: async (payload: EnqueueArgs[0], options: EnqueueArgs[1]) => {
        enqueued.push({ payload, options }); return "queue-job";
      } } as unknown as QueueProducer,
    });
    replaced = true;
    await expect(deliverSubagentCompletion(store, task.id, deliver)).rejects.toThrow("Thread scope changed");
    expect(enqueued).toHaveLength(0);
    expect(touches).toBe(0);
    await sql`UPDATE subagent_tasks SET delivery_lease_until = now() - interval '1 second' WHERE id = ${task.id}`;
    replaced = false;
    await deliverSubagentCompletion(store, task.id, deliver);
    expect(enqueued).toHaveLength(1);
    const { payload, options } = enqueued[0]!;
    expect(payload).toMatchObject({ agentId: scope.agentId, userId: scope.userId,
      organizationId: scope.organizationId, conversationId: scope.parentConversationId,
      platformMetadata: { source: "subagent-completion" } });
    expect(options).toEqual({ singletonKey: payload.messageId, durableSingleton: true });
    expect(payload.messageText).toContain(task.id);
    expect(payload.messageText).not.toContain("UNTRUSTED_CHILD_RESULT");
    expect(payload.releaseState).toBeUndefined();
    await deliverSubagentCompletion(store, task.id, deliver);
    expect(enqueued).toHaveLength(1);
  });

  test("API 拒絕缺少 claim、session token、偽造身分與匿名呼叫", async () => {
    const app = createSubagentRoutes(store);
    for (const credential of [token("user-1", false), token("user-1", true, "session")]) {
      const res = await app.request("/internal/subagents", { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(input()) });
      expect(res.status).toBe(403);
    }
    const forged = await app.request("/internal/subagents", { method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ ...input(), userId: "user-2" }) });
    expect(forged.status).toBe(400);
    expect((await app.request("/internal/subagents")).status).toBe(401);
  });
  test("派工、執行、重建 store、通知父對話且重送去重", async () => {
    const task = await store.spawn(scope, input());
    expect(task.status).toBe("queued");
    const claim = await store.claim(task.id);
    expect(claim).not.toBeNull();
    await dispatchSubagent(store, claim!, {
      codex: async (job) => ({ summary: `${job.title}完成`, artifacts: [] }),
    }, async () => true);
    const recovered = new SubagentStore(sql as unknown as DbClient);
    expect((await recovered.get(scope, task.id))?.status).toBe("completed");
    const received = new Map<string, string>();
    let crash = true;
    const deliver = async (job: { deliveryId: string; parentConversationId: string }) => {
      received.set(job.deliveryId, job.parentConversationId);
      if (crash) { crash = false; throw new Error("模擬 enqueue 成功但 ack 前 crash"); }
    };
    await expect(deliverSubagentCompletion(recovered, task.id, deliver)).rejects.toThrow("crash");
    await sql`UPDATE subagent_tasks SET delivery_lease_until = now() - interval '1 second' WHERE id = ${task.id}`;
    await deliverSubagentCompletion(recovered, task.id, deliver);
    expect(received.size).toBe(1);
    expect([...received.values()]).toEqual([scope.parentConversationId]);
    expect(await recovered.claimDelivery(task.id)).toBeNull();
  });

  test("相同派工 key 只建立一次，不接受不同的內容", async () => {
    const request = input();
    const jobs = await Promise.all(Array.from({ length: 5 }, () => store.spawn(scope, request)));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    await expect(store.spawn(scope, { ...request, prompt: "不同任務" })).rejects.toThrow("idempotency_conflict");
    await store.cancel(scope, jobs[0]!.id);
  });

  test("跨使用者讀取與取消被拒", async () => {
    const task = await store.spawn(scope, input());
    const stranger = { ...scope, userId: "user-2" };
    expect(await store.get(stranger, task.id)).toBeNull();
    expect(await store.cancel(stranger, task.id)).toBeNull();
    expect((await store.get(scope, task.id))?.status).toBe("queued");
    await store.cancel(scope, task.id);
  });

  test("兩個 consumer 只有一個 claim；取消後舊結果無效", async () => {
    const task = await store.spawn(scope, input());
    const claims = await Promise.all([store.claim(task.id), store.claim(task.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await store.cancel(scope, task.id);
    expect(await store.complete(claim, { summary: "晚到的結果", artifacts: [] })).toBe(false);
    expect((await store.get(scope, task.id))?.status).toBe("cancelled");
  });

  test("lease 到期換代後舊程序 heartbeat 和 completion 都被拒", async () => {
    const ownScope = { ...scope, parentRunId: "run-recovery" };
    const task = await store.spawn(ownScope, input());
    const old = (await store.claim(task.id))!;
    await sql`UPDATE subagent_tasks SET lease_until = now() - interval '1 second' WHERE id = ${task.id}`;
    const fresh = (await store.claim(task.id))!;
    expect(fresh.generation).toBe(old.generation + 1);
    expect(await store.heartbeat(old)).toBe(false);
    expect(await store.complete(old, { summary: "stale", artifacts: [] })).toBe(false);
    expect(await store.complete(fresh, { summary: "新執行結果", artifacts: [] })).toBe(true);
  });

  test("已逾時任務不再執行，產生可回收的終態", async () => {
    const task = await store.spawn({ ...scope, parentRunId: "run-timeout" }, input());
    await sql`UPDATE subagent_tasks SET deadline_at = now() - interval '1 second' WHERE id = ${task.id}`;
    expect(await store.claim(task.id)).toBeNull();
    expect((await store.get(scope, task.id))?.status).toBe("timed_out");
    expect(await store.claimDelivery(task.id)).not.toBeNull();
  });

  test("併發上限跨 consumer 生效，空出位置後再執行", async () => {
    const bounded = new SubagentStore(sql as unknown as DbClient, { maxConcurrentPerUser: 2 });
    const jobs = await Promise.all(Array.from({ length: 3 }, () => bounded.spawn({ ...scope, parentRunId: "run-limits" }, input())));
    const claims = await Promise.all(jobs.map((job) => bounded.claim(job.id)));
    expect(claims.filter(Boolean)).toHaveLength(2);
    await bounded.cancel(scope, claims.find(Boolean)!.id);
    const queued = jobs.find((job, index) => !claims[index])!;
    expect(await bounded.claim(queued.id)).not.toBeNull();
    for (const job of jobs) await bounded.cancel(scope, job.id);
  });
});

test("實際 worker tools → HTTP → Postgres：派工、等待、取消與去重", async () => {
  const app = createSubagentRoutes(store);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const tools = createSubagentTools({ gatewayUrl: `http://127.0.0.1:${server.port}`, workerToken: token() });
    const invoke = async (name: string, callId: string, args: unknown) => {
      const result = await tools.find((tool) => tool.name === name)!.execute(callId, args, undefined, undefined, {} as never);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    const request = { backend: "codex", title: "worker tool", prompt: "input fixture" };
    const first = await invoke("spawn_subagent", "worker-tool-call", request);
    const duplicate = await invoke("spawn_subagent", "worker-tool-call", request);
    expect(duplicate.task.id).toBe(first.task.id);
    expect(first.task.authorization).toBeUndefined();
    const pending = await invoke("wait_subagents", "wait-1", { taskIds: [first.task.id], timeoutSeconds: 0 });
    expect(pending.timedOut).toBe(true);
    const cancelled = await invoke("cancel_subagent", "cancel-1", { taskId: first.task.id });
    expect(cancelled.task.status).toBe("cancelled");
    const finished = await invoke("wait_subagents", "wait-2", { taskIds: [first.task.id], timeoutSeconds: 0 });
    expect(finished.timedOut).toBe(false);
    expect(finished.tasks[0].status).toBe("cancelled");
  } finally { await server.stop(true); }
});

test("主對話 delivery ACK 不代表主助理完成：liveness marker 存在時不喚醒", async () => {
  const task = await store.spawn({ ...scope, parentRunId: "delivery-race" }, input());
  await store.cancel(scope, task.id);
  await sql`INSERT INTO runs (id, status, queue_name, action_input) VALUES (99001, 'pending', 'internal:turn_timeout',
    ${sql.json({ conversationId: scope.parentConversationId, userId: scope.userId })})`;
  try { expect(await store.claimDelivery(task.id)).toBeNull(); }
  finally { await sql`DELETE FROM runs WHERE id=99001`; }
  expect(await store.claimDelivery(task.id)).not.toBeNull();
});

test("等待結果後 parent crash 仍有通知；parent 成功才消除背景通知", async () => {
  for (const status of ["failed", "completed"]) {
    const owner = { ...scope, parentRunId: `observe-${status}`, parentMessageId: `observe-${status}` };
    const task = await store.spawn(owner, input());
    await store.cancel(owner, task.id);
    expect(await store.observeCompletion(owner, task.id)).toBe(true);
    await sql`INSERT INTO execution_tasks VALUES (${`exec:${owner.parentMessageId}`}, ${owner.agentId}, ${owner.userId}, ${owner.parentConversationId}, ${status})`;
    const delivery = await store.claimDelivery(task.id);
    if (status === "completed") expect(delivery).toBeNull();
    else expect(delivery).not.toBeNull();
  }
});

test("status 讀取結果只有原父執行成功才抑制背景重送", async () => {
  const app = createSubagentRoutes(store);
  for (const outcome of ["completed", "failed", "wrong-user"]) {
    const messageId = `status-observe-${outcome}`;
    const owner = { ...scope, parentRunId: messageId, parentMessageId: messageId };
    const task = await store.spawn(owner, input());
    const claim = (await store.claim(task.id))!;
    await dispatchSubagent(store, claim, { codex: async () => ({ summary: "已整理", artifacts: [] }) }, async () => true);
    const response = await app.request(`/internal/subagents/${task.id}`, {
      headers: { authorization: `Bearer ${token("user-1", true, "run", messageId)}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).task.result.summary).toBe("已整理");
    await sql`INSERT INTO execution_tasks VALUES (${`exec:${messageId}`}, ${owner.agentId},
      ${outcome === "wrong-user" ? "other-user" : owner.userId}, ${owner.parentConversationId},
      ${outcome === "failed" ? "failed" : "completed"})`;
    const delivery = await store.claimDelivery(task.id);
    if (outcome === "completed") expect(delivery).toBeNull();
    else expect(delivery).not.toBeNull();
  }
});

test("刪除 agent 清理其子任務與產物，不影響同 org 的其他 agent", async () => {
  const owner = { ...scope, agentId: "agent-delete-fixture", parentRunId: "delete-fixture" };
  await sql`INSERT INTO agents (organization_id,id) VALUES (${owner.organizationId},${owner.agentId})`;
  const task = await store.spawn(owner, input());
  const claim = (await store.claim(task.id))!;
  await sql`INSERT INTO subagent_artifacts (id,task_id,generation,path,media_type,content,sha256)
    VALUES (${crypto.randomUUID()},${task.id},${claim.generation},'result.md','text/plain',decode('','base64'),'empty')`;
  await sql`DELETE FROM agents WHERE organization_id=${owner.organizationId} AND id=${owner.agentId}`;
  expect(await store.get(owner, task.id)).toBeNull();
  expect(await sql`SELECT id FROM subagent_artifacts WHERE task_id=${task.id}`).toHaveLength(0);
  expect(await store.complete(claim, { summary: "stale result", artifacts: [] })).toBe(false);
  expect(await sql`SELECT id FROM agents WHERE organization_id=${scope.organizationId} AND id=${scope.agentId}`).toHaveLength(1);
});

test("執行前撤回 capability 不會啟動 executor；錯誤不洩漏 stderr", async () => {
  const owner = { ...scope, parentRunId: "revoked-grant" };
  const task = await store.spawn(owner, input());
  const claimed = (await store.claim(task.id))!;
  let called = false;
  await dispatchSubagent(store, claimed, { codex: async () => {
    called = true; return { summary: "unexpected", artifacts: [] };
  } }, async () => false);
  expect(called).toBe(false);
  expect((await store.get(owner, task.id))?.errorCode).toBe("subagent_capability_inactive");
});

test("Codex login 跨副本去重、加密保存、跨使用者隔離與解除連接 fencing", async () => {
  const auth = new CodexAuthStore(sql as unknown as DbClient);
  const credentials = new CodexCredentialStore(sql as unknown as DbClient);
  const account = { organizationId: "auth-org", userId: "auth-user" };
  const starts = await Promise.all(Array.from({ length: 4 }, () => auth.start(account)));
  expect(new Set(starts.map((flow) => flow.id)).size).toBe(1);
  const flow = (await auth.claim(starts[0]!.id))!;
  expect(await auth.claim(flow.id)).toBeNull();
  expect(await auth.get({ ...account, userId: "other-user" }, flow.id)).toBeNull();
  const fixture = JSON.stringify({ tokens: { access_token: "dummy-access-fixture", refresh_token: "dummy-refresh-fixture" } });
  expect(await auth.complete(flow, fixture)).toBe(true);
  const saved = (await new CodexCredentialStore(sql as unknown as DbClient).load(account))!;
  expect(saved.authJson).toBe(fixture);
  const [row] = await sql`SELECT credential_ciphertext FROM subagent_codex_accounts WHERE organization_id=${account.organizationId} AND user_id=${account.userId}`;
  expect(row!.credential_ciphertext).not.toContain("dummy-access-fixture");
  expect(await credentials.load({ ...account, userId: "other-user" })).toBeNull();
  await credentials.disconnect(account);
  expect(await credentials.load(account)).toBeNull();
  expect(await credentials.save(account, saved.epoch, saved.revision, fixture)).toBe(false);
  expect(await auth.complete(flow, fixture)).toBe(false);
});

test("重新連接 Codex 先撤回舊帳號，重複點擊不重複換代，舊 refresh 不能覆蓋新帳號", async () => {
  const auth = new CodexAuthStore(sql as unknown as DbClient);
  const credentials = new CodexCredentialStore(sql as unknown as DbClient);
  const account = { organizationId: "auth-org", userId: "reconnect-user" };
  const first = (await auth.claim((await auth.start(account)).id))!;
  const fixture = JSON.stringify({ tokens: { access_token: "dummy-old-access", refresh_token: "dummy-old-refresh" } });
  expect(await auth.complete(first, fixture)).toBe(true);
  const old = (await credentials.load(account))!;
  const starts = await Promise.all([auth.start(account), auth.start(account)]);
  expect(starts[0]!.id).toBe(starts[1]!.id);
  expect(starts[0]!.accountEpoch).toBe(old.epoch + 1);
  expect(await credentials.isCurrent(account, old.epoch)).toBe(false);
  expect(await credentials.load(account)).toBeNull();
  const next = (await auth.claim(starts[0]!.id))!;
  const replacement = JSON.stringify({ tokens: { access_token: "dummy-new-access", refresh_token: "dummy-new-refresh" } });
  expect(await auth.complete(next, replacement)).toBe(true);
  expect(await credentials.save(account, old.epoch, old.revision, fixture)).toBe(false);
  expect((await credentials.load(account))!.authJson).toBe(replacement);
});

test("不同 replica 同時更新同帳號憑證只觸發一次官方 refresh", async () => {
  const auth = new CodexAuthStore(sql as unknown as DbClient);
  const account = { organizationId: "auth-org", userId: "refresh-user" };
  const first = (await auth.claim((await auth.start(account)).id))!;
  const fixture = JSON.stringify({ tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh" } });
  expect(await auth.complete(first, fixture)).toBe(true);
  const credentials = new CodexCredentialStore(sql as unknown as DbClient);
  const before = (await credentials.load(account))!;
  let calls = 0;
  const fresh = JSON.stringify({ tokens: { access_token: "dummy-new-access", refresh_token: "dummy-new-refresh" } });
  const results = await Promise.all(Array.from({ length: 4 }, () => new CodexCredentialStore(sql as unknown as DbClient)
    .refresh(account, before.epoch, before.revision, async input => { expect(input).toBe(fixture); calls++; return fresh; })));
  expect(calls).toBe(1);
  expect(results.every(result => result.revision === before.revision + 1 && result.authJson === fresh)).toBe(true);
  await credentials.disconnect(account);
  await expect(credentials.refresh(account, before.epoch, before.revision, async () => fresh)).rejects.toThrow("codex_needs_connection");
});

test("完整 Codex executor 經真實子程序協定：集中 refresh、external login、401 refresh、結果與清理", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shifu-codex-executor-test-"));
  try {
    const binary = join(directory, "fixture-codex");
    const externalFile = join(directory, "outside-workspace.txt");
    await writeFile(externalFile, "must-remain-unchanged");
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const rl = require('node:readline').createInterface({input: process.stdin});
const authFile = path.join(process.env.CODEX_HOME, 'auth.json');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let external = false; let turn;
rl.on('line', line => { const m = JSON.parse(line); const reply = result => send({id:m.id,result});
  if (m.id === 900 && !m.method) {
    if (!m.result?.accessToken || m.result.refreshToken) process.exit(7);
    send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',text:'已完成委派資料分析'}}});
    send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{status:'completed'}}}); return;
  }
  if (m.method === 'initialize') reply({});
  if (m.method === 'account/read') {
    const auth = JSON.parse(fs.readFileSync(authFile,'utf8'));
    auth.tokens.access_token += '-refreshed'; auth.tokens.refresh_token += '-rotated';
    fs.writeFileSync(authFile,JSON.stringify(auth)); reply({account:{type:'chatgpt'}});
  }
  if (m.method === 'account/login/start') {
    if (m.params.type !== 'chatgptAuthTokens' || fs.existsSync(authFile) || m.params.refreshToken) process.exit(8);
    external = true; reply({type:'chatgptAuthTokens'});
  }
  if (m.method === 'thread/start') {
    if (!external || m.params.permissions !== 'shifu-subagent') process.exit(9);
    reply({thread:{id:'fixture-thread'}});
  }
  if (m.method === 'turn/start') {
    fs.symlinkSync(${JSON.stringify(externalFile)}, path.join(process.cwd(), 'result.md'));
    reply({turn:{id:'fixture-turn'}});
    send({id:900,method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'fixture-account'}});
  }
});
`, { mode: 0o700 });
    const credentials = new CodexCredentialStore(sql as unknown as DbClient);
    const auth = new CodexAuthStore(sql as unknown as DbClient);
    const flow = (await auth.claim((await auth.start(scope)).id))!;
    expect(await auth.complete(flow, JSON.stringify({ tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh", account_id: "fixture-account" } }))).toBe(true);
    const artifacts = new SubagentArtifactStore(sql as unknown as DbClient);
    const options = { binary, stateRoot: directory, path: "/usr/bin:/bin", credentials, artifacts };
    const task = (await store.claim((await store.spawn(scope, input())).id))!;
    const result = await createCodexExecutor(options)(task, new AbortController().signal);
    expect(result.summary).toBe("已完成委派資料分析");
    const account = await prepareCodexAccount(options, task);
    const runRoot = join(account.accountDir, "tasks", task.id, String(task.generation));
    expect(await readdir(runRoot)).toEqual(["workspace"]);
    expect(await readFile(externalFile, "utf8")).toBe("must-remain-unchanged");
    expect((await readdir(account.accountDir)).filter(name => name.startsWith("refresh-"))).toEqual([]);
    const saved = (await credentials.load(task))!;
    expect(JSON.parse(saved.authJson).tokens.refresh_token).toBe("dummy-refresh-rotated-rotated");
    await store.complete(task, result);
    expect((await store.get(scope, task.id))?.status).toBe("completed");
    await rm(runRoot, { recursive: true, force: true });
    const artifact = await new SubagentArtifactStore(sql as unknown as DbClient).get(task, result.artifacts[0]!.id!);
    expect(Buffer.from(artifact!.contentBase64, "base64").toString()).toBe(result.summary);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

test("產物只公開已完成的本使用者 generation，略過 symlink 且拒絕逾期程序寫入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shifu-artifacts-test-"));
  try {
    const workspace = join(directory, "workspace"); await mkdir(workspace);
    await writeFile(join(directory, "private.txt"), "not-an-artifact");
    await symlink(join(directory, "private.txt"), join(workspace, "escape.txt"));
    await writeFile(join(workspace, "result.md"), "owned result");
    const artifacts = new SubagentArtifactStore(sql as unknown as DbClient);
    const task = (await store.claim((await store.spawn(scope, input())).id))!;
    const files = await artifacts.collect(task, workspace);
    expect(files.map(file => file.path)).toEqual(["result.md"]);
    expect(await artifacts.get(task, files[0]!.id!)).toBeNull();
    await store.complete(task, { summary: "owned result", artifacts: files });
    expect(await artifacts.get({ ...task, userId: "other-user" }, files[0]!.id!)).toBeNull();
    expect((await artifacts.get(task, files[0]!.id!))?.size).toBe(12);
    await expect(artifacts.collect(task, workspace)).rejects.toThrow("stale_execution");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Codex login 失去 lease 後不能套用，使用者可重新啟動新流程", async () => {
  const auth = new CodexAuthStore(sql as unknown as DbClient);
  const account = { organizationId: "auth-org", userId: "interrupted-user" };
  const flow = (await auth.claim((await auth.start(account)).id))!;
  await sql`UPDATE subagent_codex_auth_flows SET lease_until=now()-interval '1 second' WHERE id=${flow.id}`;
  const fixture = JSON.stringify({ tokens: { access_token: "dummy-access", refresh_token: "dummy-refresh" } });
  expect(await auth.complete(flow, fixture)).toBe(false);
  const restarted = await auth.start(account);
  expect(restarted.id).not.toBe(flow.id);
  expect((await auth.get(account, flow.id))?.status).toBe("expired");
});

test("SSE 已斷線仍可取回主助理持久化回覆，其他使用者的 terminal 不可混入", async () => {
  const task = await store.spawn({ ...scope, parentRunId: "99200" }, input());
  const parent = { agentId: scope.agentId, userId: scope.userId, organizationId: scope.organizationId,
    conversationId: scope.parentConversationId, channelId: `api_${scope.userId}` };
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99200,'completed','messages',${sql.json(parent)},${scope.organizationId})`;
  const terminal = { ...parent, processedMessageIds: [`subagent-completion:${task.id}`], finalText: "整理後的主助理回覆" };
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99201,'failed','thread_response',${sql.json({ ...terminal, userId: "someone-else" })},${scope.organizationId})`;
  expect(await getSubagentParentCompletion(sql as unknown as DbClient, task)).toBeNull();
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99202,'failed','thread_response',${sql.json(terminal)},${scope.organizationId})`;
  const completion = await getSubagentParentCompletion(sql as unknown as DbClient, task);
  expect(completion?.text).toBe("整理後的主助理回覆");
  expect(completion?.messageId).toBe(`subagent-completion:${task.id}`);
  expect(await getSubagentParentCompletion(sql as unknown as DbClient, { ...task, userId: "someone-else" })).toBeNull();
  await sql`UPDATE runs SET action_input=${sql.json({ ...terminal, awaitingHumanDecision: true })} WHERE id=99202`;
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99203,'completed','messages',${sql.json({ ...parent, messageId: `subagent-completion:${task.id}` })},${scope.organizationId})`;
  const confirmationContext = { kind: "automation_create", planId: "plan-fixture", planVersion: 1, contentHash: "fixture-hash" };
  const event = { ...parent, platformMetadata: { sourceRunId: 99203 }, customEvent: { name: "shifu.work_state", data: { confirmationContext } } };
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99204,'failed','thread_response',${sql.json({ ...event, userId: "someone-else" })},${scope.organizationId})`;
  expect((await getSubagentParentCompletion(sql as unknown as DbClient, task))?.confirmationContext).toBeUndefined();
  await sql`INSERT INTO runs (id,status,queue_name,action_input,organization_id)
    VALUES (99205,'failed','thread_response',${sql.json(event)},${scope.organizationId})`;
  expect((await getSubagentParentCompletion(sql as unknown as DbClient, task))?.confirmationContext).toEqual(confirmationContext);
});

test("Toolbox 管理端驗證 PAT、org 與 personal-agent owner，沒有憑證讀取出口", async () => {
  const routes = createSubagentProvisioningRoutes({ sql: sql as unknown as DbClient });
  expect((await routes.request('/agents/agent-1/subagents/codex?userId=user-1')).status).toBe(403);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('authSource', 'pat'); c.set('session', { id: 'pat:test' } as never);
    c.set('mcpAuthInfo', { scopes: ['mcp:admin'] } as never);
    c.set('organizationId', c.req.header('x-test-org') || 'org-1');
    await next();
  });
  app.route('/', routes);
  const allowed = await app.request('/agents/agent-1/subagents/codex?userId=user-1');
  expect(allowed.status).toBe(200);
  expect(Object.keys(await allowed.json()).sort()).toEqual(['available', 'connected']);
  expect((await app.request('/agents/agent-1/subagents/codex?userId=victim')).status).toBe(404);
  expect((await app.request('/agents/agent-1/subagents/codex?userId=user-1', { headers: { 'x-test-org': 'other-org' } })).status).toBe(404);
});
