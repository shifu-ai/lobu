import { generateWorkerToken, type WorkerTokenData } from "@lobu/core";
import type { McpProxy } from "../auth/mcp/proxy";
import type { SubagentDelegation, SubagentTask } from "./types";

export function createSubagentToolDelegate(proxy: McpProxy) {
  return {
    async resolve(worker: WorkerTokenData, token: string, refs: Array<{ mcpId: string; name: string }>): Promise<SubagentDelegation> {
      const tools = [];
      for (const ref of refs) {
        const tool = await proxy.describeDelegatedReadTool(worker.agentId!, worker.userId, ref.mcpId, ref.name, worker, token);
        if (!tool) throw new Error("subagent_tool_not_delegatable");
        tools.push(tool);
      }
      const delegation = { tools, ...(worker.executionMode ? { executionMode: worker.executionMode } : {}),
        ...(worker.courseToolScope ? { courseToolScope: worker.courseToolScope } : {}),
        ...(worker.channelId ? { channelId: worker.channelId } : {}) };
      if (Buffer.byteLength(JSON.stringify(delegation)) > 131072) throw new Error("subagent_tool_scope_too_large");
      return delegation;
    },
    async call(task: SubagentTask, worker: WorkerTokenData, token: string, index: number, args: Record<string, unknown>,
      stillActive: () => Promise<boolean>) {
      const tool = task.delegation?.tools[index];
      if (!tool) throw new Error("subagent_tool_not_delegated");
      const scopedWorker = { ...worker, channelId: task.delegation?.channelId ?? worker.channelId,
        courseToolScope: task.delegation?.courseToolScope };
      const current = await proxy.describeDelegatedReadTool(task.agentId, task.userId, tool.mcpId, tool.name, scopedWorker, token);
      if (!current || current.identity.upstreamOrigin !== tool.identity.upstreamOrigin ||
        current.identity.configSource !== tool.identity.configSource || current.identity.configDigest !== tool.identity.configDigest) {
        throw new Error("subagent_tool_scope_changed");
      }
      if (!await stillActive()) throw new Error("subagent_execution_inactive");
      if (!task.authorization) throw new Error("subagent_authorization_required");
      // 只有 gateway 在已重新驗證的單次唯讀呼叫內持有此 token，絕不回傳給 child。
      // 保留該 target 的 applied capability，讓上游仍能檢查其 release-gated 查詢。
      const scopedToken = generateWorkerToken(task.userId, task.childConversationId, "subagent-tool-gateway", {
        agentId: task.agentId, organizationId: task.organizationId, channelId: scopedWorker.channelId,
        tokenKind: "run", runId: worker.runId, messageId: worker.messageId,
        courseToolScope: task.delegation?.courseToolScope, executionMode: task.delegation?.executionMode,
        releaseState: { status: "active", claim: task.authorization },
      });
      return proxy.callToolWithApproval(task.agentId, task.userId, tool.mcpId, tool.name, args, {
        token: scopedToken, organizationId: task.organizationId, conversationId: task.childConversationId,
        channelId: task.delegation?.channelId, courseToolScope: task.delegation?.courseToolScope,
        expectedMcpIdentity: tool.identity,
        // 不帶父對話 processedMessageIds 或核准；child 自己的 token 仍保持不可再委派。
      });
    },
  };
}

export type SubagentToolDelegate = ReturnType<typeof createSubagentToolDelegate>;
