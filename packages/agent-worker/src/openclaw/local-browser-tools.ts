import type { ReleaseCapabilityState } from "@lobu/core";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

export const PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY =
  "personal_browser.local_ego.v1";

export const LOCAL_EGO_BROWSER_TOOLS = [
  "browser_read_dom",
  "browser_screenshot",
  "browser_navigate",
] as const;

export type LocalEgoBrowserToolName = (typeof LOCAL_EGO_BROWSER_TOOLS)[number];

export interface ProjectedBrowserTool {
  name: LocalEgoBrowserToolName;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LocalBrowserToolResult {
  ok?: boolean;
  url?: string | null;
  title?: string;
  contentType?: "dom" | "screenshot" | "navigation";
  text?: string;
  imageBase64?: string;
  metadata?: Record<string, unknown>;
}

const LOCAL_EGO_BROWSER_TOOL_SET = new Set<string>(LOCAL_EGO_BROWSER_TOOLS);

export function projectBrowserTools(input: {
  capabilityIds: string[];
}): ProjectedBrowserTool[] {
  if (!input.capabilityIds.includes(PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY)) {
    return [];
  }
  return LOCAL_EGO_BROWSER_TOOLS.map((name) => ({
    name,
    description: browserToolDescription(name),
    input_schema: browserToolSchema(name),
  }));
}

export function releaseCapabilityIdsForBrowserTools(input: {
  releaseState?: ReleaseCapabilityState;
  agentId: string;
  now?: Date;
}): string[] {
  if (input.releaseState?.status !== "active") return [];
  const { claim } = input.releaseState;
  if (claim.agentId !== input.agentId) return [];
  const expiresAtMs = Date.parse(claim.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= (input.now ?? new Date()).getTime()
  ) {
    return [];
  }
  return claim.capabilityIds;
}

export async function callLocalBrowserTool(input: {
  gatewayUrl: string;
  workerToken: string;
  toolName: LocalEgoBrowserToolName;
  args: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LocalBrowserToolResult> {
  assertLocalBrowserToolName(input.toolName);
  const gatewayUrl = input.gatewayUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 60_000
  );
  try {
    const response = await (input.fetchImpl ?? fetch)(
      // `gatewayUrl` is the worker's DISPATCHER_URL, which already ends in the
      // `/lobu` mount (see getInternalGatewayUrl in @lobu/server). Repeating
      // the prefix here produced `/lobu/lobu/api/...` — a bare 404 with no
      // error body, indistinguishable at a glance from the route being absent.
      // Every other worker→gateway call is relative to the mount the same way
      // (e.g. `${gatewayUrl}/worker/internal/...`).
      `${gatewayUrl}/api/browser/local-ego/tools/${input.toolName}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.workerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ arguments: input.args }),
        signal: controller.signal,
      }
    );
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const error =
        typeof body.error === "string" && body.error.trim()
          ? body.error
          : `browser_tool_failed_${response.status}`;
      throw new Error(error);
    }
    return parseLocalBrowserToolResult(body);
  } finally {
    clearTimeout(timeout);
  }
}

export function createLocalBrowserAgentTools(input: {
  gatewayUrl: string;
  workerToken: string;
  capabilityIds: string[];
}): AgentTool<any, Record<string, unknown>>[] {
  if (!input.gatewayUrl || !input.workerToken) return [];
  return projectBrowserTools({ capabilityIds: input.capabilityIds }).map(
    (tool): AgentTool<any, Record<string, unknown>> => ({
      name: tool.name,
      label: `local-ego/${tool.name}`,
      description: tool.description,
      parameters: Type.Unsafe(tool.input_schema),
      execute: async (_toolCallId, args) =>
        toAgentToolResult(
          await callLocalBrowserTool({
            gatewayUrl: input.gatewayUrl,
            workerToken: input.workerToken,
            toolName: tool.name,
            args: normalizeArgs(args),
          })
        ),
    })
  );
}

function browserToolDescription(name: LocalEgoBrowserToolName): string {
  switch (name) {
    case "browser_read_dom":
      return "Read visible text and page metadata from the user's active local ego browser session.";
    case "browser_screenshot":
      return "Capture a screenshot from the user's active local ego browser session.";
    case "browser_navigate":
      return "Navigate the user's active local ego browser session to an approved URL.";
  }
}

function browserToolSchema(
  name: LocalEgoBrowserToolName
): Record<string, unknown> {
  switch (name) {
    case "browser_read_dom":
      return Type.Object(
        {
          maxTextBytes: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false }
      );
    case "browser_screenshot":
      return Type.Object(
        {
          maxImageBase64Bytes: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false }
      );
    case "browser_navigate":
      return Type.Object(
        {
          url: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false }
      );
  }
}

function assertLocalBrowserToolName(
  value: string
): asserts value is LocalEgoBrowserToolName {
  if (!LOCAL_EGO_BROWSER_TOOL_SET.has(value)) {
    throw new Error("unknown_local_browser_tool");
  }
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseLocalBrowserToolResult(
  body: Record<string, unknown>
): LocalBrowserToolResult {
  const inner =
    body.ok === true && body.result && typeof body.result === "object"
      ? (body.result as Record<string, unknown>)
      : body;
  return {
    ok: inner.ok === true ? true : undefined,
    url:
      typeof inner.url === "string" || inner.url === null
        ? inner.url
        : undefined,
    title: typeof inner.title === "string" ? inner.title : undefined,
    contentType:
      inner.contentType === "dom" ||
      inner.contentType === "screenshot" ||
      inner.contentType === "navigation"
        ? inner.contentType
        : undefined,
    text: typeof inner.text === "string" ? inner.text : undefined,
    imageBase64:
      typeof inner.imageBase64 === "string" ? inner.imageBase64 : undefined,
    metadata:
      inner.metadata && typeof inner.metadata === "object"
        ? (inner.metadata as Record<string, unknown>)
        : undefined,
  };
}

function toAgentToolResult(
  result: LocalBrowserToolResult
): AgentToolResult<Record<string, unknown>> {
  const content: AgentToolResult<Record<string, unknown>>["content"] = [];
  if (result.text) {
    content.push({ type: "text", text: result.text });
  }
  if (result.imageBase64) {
    content.push({
      type: "image",
      data: result.imageBase64,
      mimeType: "image/png",
    });
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: JSON.stringify(
        {
          url: result.url ?? null,
          title: result.title,
          contentType: result.contentType,
          metadata: result.metadata,
        },
        null,
        2
      ),
    });
  }
  return { content, details: result as Record<string, unknown> };
}
