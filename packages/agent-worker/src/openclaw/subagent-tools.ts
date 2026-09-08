import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** The gateway derives identity, grants and parent linkage from the run token. */
export function createSubagentTools(params: {
  gatewayUrl: string;
  workerToken: string;
}): ToolDefinition[] {
  async function call(
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal
  ) {
    try {
      const response = await fetch(
        `${params.gatewayUrl.replace(/\/$/, "")}/internal/subagents${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${params.workerToken}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        }
      );
      const value = await response.json();
      // Credentials and release evidence have no place in model context.
      const redact = (key: string, val: unknown) =>
        key === "authorization" ? undefined : val;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(value, redact) },
        ],
        details: {},
        ...(response.ok ? {} : { isError: true }),
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: "子任務服務暫時無法連線；若派工已送出，請先查詢狀態，避免重複派工。",
          },
        ],
        details: {},
        isError: true,
      };
    }
  }
  return [
    {
      name: "spawn_subagent",
      label: "委派子任務",
      description:
        "把有明確目標及輸入資料的子任務委派給 Codex 或 Lobu，立即回傳 task id。多次呼叫可並行。Lobu 可用 allowedTools 指定現有 MCP 的精確 mcpId/name，只接受目前政策允許的唯讀工具；Codex 不接受此欄位的非空清單。子代理不會自動繼承整段對話或外部寫入權。用 wait_subagents 收取結果，再由你整合回覆使用者。能力未開通或未連接帳號時應如實說明。",
      parameters: Type.Object(
        {
          backend: Type.Union([Type.Literal("codex"), Type.Literal("lobu")]),
          title: Type.String({ minLength: 1, maxLength: 200 }),
          prompt: Type.String({ minLength: 1, maxLength: 65536 }),
          allowedTools: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  mcpId: Type.String({ minLength: 1, maxLength: 200 }),
                  name: Type.String({ minLength: 1, maxLength: 200 }),
                },
                { additionalProperties: false }
              ),
              { maxItems: 16 }
            )
          ),
          timeoutSeconds: Type.Optional(
            Type.Integer({ minimum: 10, maximum: 1800 })
          ),
        },
        { additionalProperties: false }
      ),
      execute: (toolCallId, args, signal) =>
        call(
          "",
          "POST",
          { ...(args as Record<string, unknown>), idempotencyKey: toolCallId },
          signal
        ),
    },
    {
      name: "subagent_status",
      label: "子任務進度",
      description:
        "查詢原主對話中的子任務狀態、錯誤與結果；省略 taskId 可列出最近任務。",
      parameters: Type.Object(
        { taskId: Type.Optional(Type.String({ format: "uuid" })) },
        { additionalProperties: false }
      ),
      execute: (_id, args, signal) =>
        call(
          (args as { taskId?: string }).taskId
            ? `/${encodeURIComponent((args as { taskId: string }).taskId)}`
            : "",
          "GET",
          undefined,
          signal
        ),
    },
    {
      name: "wait_subagents",
      label: "等待子任務",
      description:
        "等待指定子任務，任一任務完成即回傳結果。每次最多等 25 秒；未完成的任務仍會繼續。若你先結束本輪，背景完成後會喚回原主對話。不要宣稱尚未回傳的任務已完成。",
      parameters: Type.Object(
        {
          taskIds: Type.Array(Type.String({ format: "uuid" }), {
            minItems: 1,
            maxItems: 8,
          }),
          timeoutSeconds: Type.Optional(
            Type.Integer({ minimum: 0, maximum: 25 })
          ),
        },
        { additionalProperties: false }
      ),
      execute: (_id, args, signal) => call("/wait", "POST", args, signal),
    },
    {
      name: "cancel_subagent",
      label: "取消子任務",
      description:
        "取消原主對話中的子任務。已完成的結果保留；取消後不再接受舊程序回傳的結果。",
      parameters: Type.Object(
        { taskId: Type.String({ format: "uuid" }) },
        { additionalProperties: false }
      ),
      execute: (_id, args, signal) =>
        call(
          `/${encodeURIComponent((args as { taskId: string }).taskId)}/cancel`,
          "POST",
          {},
          signal
        ),
    },
  ];
}
