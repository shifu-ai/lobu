import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { verifyWorkerToken, type WorkerTokenData } from "@lobu/core";
import { McpProxy } from "../../auth/mcp/proxy";
import { createSubagentToolDelegate } from "../delegated-tools";
import type { SubagentTask } from "../types";

const identity = { upstreamOrigin: "https://fixture.invalid", configSource: "agent" as const, configDigest: "fixture" };
const previousKey = process.env.ENCRYPTION_KEY;
beforeAll(() => { process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex"); });
afterAll(() => { if (previousKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = previousKey; });
const worker = { userId: "user", agentId: "agent", organizationId: "org", channelId: "channel", conversationId: "child",
  runId: 123, messageId: "child-message",
  processedMessageIds: ["parent-approved"], courseToolScope: { ownerUserId: "user", agentId: "agent", courseEntityId: "course" } } as WorkerTokenData;

test("實際 MCP 委派政策拒絕未標唯讀、破壞性、設定禁用與明確拒絕的工具", async () => {
  for (const variant of ["allowed", "missing", "write", "destructive", "settings-denied", "grant-denied", "identity-missing"]) {
    const proxy = {
      agentSettingsStore: { getSettings: async () => ({ toolsConfig: variant === "settings-denied" ? { deniedTools: ["read"] } : {} }) },
      globalToolPolicyResolver: () => ({}),
      grantStore: { isDenied: async () => variant === "grant-denied" },
      fetchToolsForMcp: async () => ({ tools: [{ name: "read", annotations: variant === "missing" ? undefined : {
        readOnlyHint: variant !== "write", destructiveHint: variant === "destructive" } }],
        provenance: variant === "identity-missing" ? undefined : identity }),
    };
    const result = await McpProxy.prototype.describeDelegatedReadTool.call(proxy as unknown as McpProxy, "agent", "user", "mcp", "read", worker, "fixture");
    expect(Boolean(result)).toBe(variant === "allowed");
  }
});

test("委派重新核對連接與執行資格，呼叫沿用既有 approval 入口而不帶父核准", async () => {
  let currentIdentity = identity;
  const calls: unknown[][] = [];
  const proxy = {
    describeDelegatedReadTool: async () => ({ mcpId: "mcp", name: "read", identity: currentIdentity }),
    callToolWithApproval: async (...args: unknown[]) => { calls.push(args); return { status: "executed", content: [], isError: false }; },
  } as unknown as McpProxy;
  const delegate = createSubagentToolDelegate(proxy);
  const delegation = await delegate.resolve(worker, "parent-token", [{ mcpId: "mcp", name: "read" }]);
  expect(delegation.courseToolScope).toEqual(worker.courseToolScope);
  const task = { id: "task", agentId: "agent", userId: "user", organizationId: "org", childConversationId: "child", delegation,
    authorization: { environment: "staging", toolboxUserId: "user", agentId: "agent", releaseId: "release", releaseSequence: 1,
      snapshotDigest: `sha256:${"a".repeat(64)}`, expiresAt: new Date(Date.now()+60000).toISOString(), capabilityIds: ["agent.subagents.v1"] } } as SubagentTask;
  await expect(delegate.call(task, worker, "child-token", 1, {}, async () => true)).rejects.toThrow("subagent_tool_not_delegated");
  await expect(delegate.call(task, worker, "child-token", 0, {}, async () => false)).rejects.toThrow("subagent_execution_inactive");
  currentIdentity = { ...identity, configDigest: "changed" };
  await expect(delegate.call(task, worker, "child-token", 0, {}, async () => true)).rejects.toThrow("subagent_tool_scope_changed");
  expect(calls).toHaveLength(0);
  currentIdentity = identity;
  await delegate.call(task, worker, "child-token", 0, { query: "course" }, async () => true);
  expect(calls).toHaveLength(1);
  const context = calls[0]![5] as Record<string, unknown>;
  expect(context.courseToolScope).toEqual(worker.courseToolScope);
  expect(context.token).not.toBe("child-token");
  const scoped = verifyWorkerToken(context.token as string)!;
  expect(scoped.releaseState?.status).toBe("active");
  expect(scoped.conversationId).toBe("child");
  expect(scoped.processedMessageIds).toBeUndefined();
  expect(context.processedMessageIds).toBeUndefined();
  expect(context.releaseState).toBeUndefined();
});

test("既有 approval 入口會拒絕跨課程查詢並補上受信任範圍", async () => {
  const calls: Record<string, unknown>[] = [];
  const proxy = {
    runPreToolGuardrails: async () => false,
    evaluateToolApproval: async () => "allow",
    executeToolDirect: async (_agent: string, _user: string, _mcp: string, _name: string, args: Record<string, unknown>) => {
      calls.push(args); return { content: [], isError: false };
    },
  } as unknown as McpProxy;
  const call = (args: Record<string, unknown>) => McpProxy.prototype.callToolWithApproval.call(proxy,
    "agent", "user", "mcp", "search_memory", args, { courseToolScope: worker.courseToolScope });
  expect((await call({ entity_ids: ["another-course"] })).diagnosticCode).toBe("COURSE_SCOPE_MISMATCH");
  expect(calls).toHaveLength(0);
  await call({ query: "課程" });
  expect(calls).toEqual([{ query: "課程", owner_user_id: "user", agent_id: "agent", entity_ids: ["course"] }]);
});
