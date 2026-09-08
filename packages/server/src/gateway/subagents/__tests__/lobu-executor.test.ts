import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkerToken } from "@lobu/core";
import type { ISessionManager, ThreadSession } from "../../session";
import { createLobuExecutor } from "../lobu-executor";
import type { SubagentTask } from "../types";

let root: string;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  root = await mkdtemp(join(tmpdir(), "shifu-lobu-child-test-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});
const task: SubagentTask = {
  id: "00000000-0000-4000-8000-000000000001", organizationId: "child-org", userId: "child-user",
  agentId: "child-agent", parentConversationId: "parent", parentRunId: "40", executionRunId: 41,
  childConversationId: "subagent:test-child", backend: "lobu", title: "子代理測試", prompt: "整理提供的課程資料",
  status: "running", generation: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(), result: null, errorCode: null,
};

test("Lobu 子程序建立獨立 session、帶自己的 run token，且不繼承服務環境", async () => {
  const entry = join(root, "fixture.cjs");
  await writeFile(entry, `const fs = require('node:fs');
    let input=''; process.stdin.on('data', c => input+=c); process.stdin.on('end', () => {
      fs.writeFileSync('observed.json', JSON.stringify({ input: JSON.parse(input), env: process.env }));
      fs.writeFileSync('result.md', '整理結果');
      console.log(JSON.stringify({type:'subagent_result',summary:'整理結果'}));
    });`);
  const sessions: ThreadSession[] = [];
  const sessionManager = { setSession: async (value: ThreadSession) => { sessions.push(value); } } as unknown as ISessionManager;
  const executor = createLobuExecutor({ stateRoot: join(root, "state"), dispatcherUrl: "http://127.0.0.1:8787",
    sessionManager, workerEntry: entry });
  const result = await executor(task, new AbortController().signal);
  expect(result.summary).toBe("整理結果");
  expect(sessions[0]!.conversationId).toBe(task.childConversationId);
  expect(sessions[0]!.conversationId).not.toBe(task.parentConversationId);
  const observed = JSON.parse(await readFile(join(sessions[0]!.workingDirectory!, "observed.json"), "utf8"));
  expect(observed.input).toEqual({ prompt: task.prompt, agentId: task.agentId, userId: task.userId });
  expect(observed.env.ENCRYPTION_KEY).toBeUndefined();
  expect(observed.env.DATABASE_URL).toBeUndefined();
  expect(observed.env.HOME).toBe(sessions[0]!.workingDirectory);
  const claims = verifyWorkerToken(observed.env.WORKER_TOKEN)!;
  expect(claims.runId).toBe(41);
  expect(claims.conversationId).toBe(task.childConversationId);
  expect(claims.userId).toBe(task.userId);
  expect(claims.releaseState?.status).toBe("enrolled_inactive");
});

test("取消 Lobu 子程序會結束等待並拒收結果", async () => {
  const entry = join(root, "waiting.cjs");
  await writeFile(entry, "setInterval(() => {}, 1000);");
  const sessionManager = { setSession: async () => {} } as unknown as ISessionManager;
  const executor = createLobuExecutor({ stateRoot: join(root, "cancel-state"), dispatcherUrl: "http://127.0.0.1:8787",
    sessionManager, workerEntry: entry });
  const controller = new AbortController();
  const result = executor(task, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await expect(result).rejects.toThrow("lobu_subagent_failed");
}, 5000);

test("Lobu 子代理不能使用缺少 queue run 的派工身分", async () => {
  const executor = createLobuExecutor({ stateRoot: root, dispatcherUrl: "http://127.0.0.1:8787",
    sessionManager: { setSession: async () => { throw new Error('must not create'); } } as unknown as ISessionManager });
  await expect(executor({ ...task, executionRunId: undefined }, new AbortController().signal)).rejects.toThrow("lobu_subagent_invalid_dispatch");
});

test("實際 Lobu worker 經 provider proxy 分析，只送委派材料且不提供工具", async () => {
  const requests: Array<{ path: string; body: any; authorization: string | null }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, body: request.method === "POST" ? await request.json() : null,
      authorization: request.headers.get("authorization") });
    if (url.pathname.endsWith("/worker/session-context")) return Response.json({
      userId: task.userId, agentId: task.agentId, platformInstructions: "主對話隱私，不應出現在子模型輸入",
      networkInstructions: "", mcpStatus: [], agentInstructions: "不應繼承的完整個人資料",
      providerConfig: { defaultProvider: "openai", defaultModel: "openai/subagent-fixture-model",
        providerBaseUrlMappings: { OPENAI_BASE_URL: `${url.origin}/lobu/api/proxy/openai/v1` } },
    });
    if (url.pathname.endsWith("/chat/completions")) {
      const chunks = [
        { id: "fixture", object: "chat.completion.chunk", created: 1, model: "subagent-fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "已整理提供的資料。" }, finish_reason: null }] },
        { id: "fixture", object: "chat.completion.chunk", created: 1, model: "subagent-fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("Not found", { status: 404 });
  } });
  try {
    const sessions: ThreadSession[] = [];
    const executor = createLobuExecutor({ stateRoot: join(root, "real-worker"), dispatcherUrl: server.url.origin,
      sessionManager: { setSession: async (value: ThreadSession) => { sessions.push(value); } } as unknown as ISessionManager });
    const result = await executor(task, new AbortController().signal).catch(() => {
      throw new Error(`Fixture worker failed after requests: ${requests.map(request => request.path).join(",")}`);
    });
    expect(result.summary).toBe("已整理提供的資料。");
    const inference = requests.find(request => request.path.endsWith("/chat/completions"))!;
    expect(inference).toBeDefined();
    expect(inference.body.tools ?? []).toEqual([]);
    const input = JSON.stringify(inference.body.messages);
    expect(input).toContain(task.prompt);
    expect(input).not.toContain("主對話隱私");
    expect(input).not.toContain("完整個人資料");
    const claims = verifyWorkerToken(inference.authorization!.slice("Bearer ".length))!;
    expect(claims.conversationId).toBe(task.childConversationId);
    expect(await readFile(join(sessions[0]!.workingDirectory!, "result.md"), "utf8")).toBe(result.summary);
  } finally { server.stop(true); }
}, 15000);
