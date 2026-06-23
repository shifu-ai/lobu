# MCP Safe Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenClaw-inspired safety layer so Lobu can keep production `mcpExposure=cli` while making `mcpExposure=tools` safe enough for Gemini through per-server `toolFilter`, schema quarantine/projection, tool caps, broken-server backoff, catalog cache invalidation, and MCP result normalization.

**Architecture:** Keep MCP as a first-class capability, but insert a provider-safe projection boundary between Gateway discovery and worker tool materialization. Gateway owns server inventory, tool filtering, cache/backoff, and diagnostics; worker owns provider-specific schema projection, final hard caps, and result normalization before provider history. Broker exposure is added after the safety layer as a separate exposure mode with only three first-class broker tools.

**Tech Stack:** TypeScript, Bun tests, TypeBox, Lobu Gateway MCP proxy, Lobu OpenClaw worker, `@mariozechner/pi-coding-agent` tool definitions.

---

## Source Notes

- OpenClaw docs say embedded runtime exposes configured MCP tools in normal `coding` and `messaging` profiles, while `minimal` hides them and `tools.deny: ["bundle-mcp"]` disables them.
- OpenClaw docs also specify per-server `toolFilter.include` / `toolFilter.exclude`, cached session catalogs invalidated by dynamic tool-list changes, and short broken-server pauses after repeated MCP protocol/tool request failures.
- Lobu already has `mcpExposure: "tools" | "cli"` in `packages/core/src/types.ts`, but no per-server tool filter, no schema quarantine metadata, no provider-safe schema projection, and no hard cap for Gemini tools mode.
- Current direct-materialization path is: Gateway `fetchToolsForMcp()` returns `mcpTools` in `packages/server/src/gateway/gateway/index.ts`; worker `createMcpToolDefinitions()` in `packages/agent-worker/src/openclaw/custom-tools.ts` wraps every `inputSchema` with `Type.Unsafe()` and registers it as a first-class tool.

## Non-Goals

- Do not switch production LINE agents back to `mcpExposure=tools` in this PR.
- Do not remove `mcpExposure=cli`; it remains the default safe production mode until real Gemini/tool-surface smokes pass.
- Do not implement per-project agent provisioning in this plan.
- Do not manually deploy Toolbox staging or Lobu to Zeabur as part of this implementation.

## File Structure

Create:
- `packages/core/src/utils/mcp-tool-filter.ts` - exact/glob include/exclude matching for MCP tool names.
- `packages/core/src/utils/mcp-safe-schema.ts` - provider-neutral JSON Schema validation, projection, and quarantine reason helpers.
- `packages/server/src/gateway/auth/mcp/server-health.ts` - per-process broken-server backoff state for discovery and tool-call failures.
- `packages/agent-worker/src/openclaw/mcp-tool-projection.ts` - worker-side provider-aware projection and Gemini cap enforcement.
- `packages/agent-worker/src/openclaw/mcp-result-normalizer.ts` - MCP result content normalization into safe text/image-only output.
- `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`
- `packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts`
- `packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts`
- `packages/server/src/gateway/__tests__/mcp-server-health.test.ts`

Modify:
- `packages/core/src/types.ts` - add `McpToolFilter`, extend `McpServerConfig`, extend `ToolsConfig.mcpExposure` to include `broker`, add optional `mcpDirectToolLimit`.
- `packages/core/src/utils/mcp-tool-instructions.ts` - add optional projection/quarantine metadata to `McpToolDef`.
- `packages/core/src/index.ts` - export new utility types/functions.
- `packages/server/src/gateway/auth/mcp/config-service.ts` - preserve `toolFilter` when normalizing per-agent and global MCP server configs.
- `packages/server/src/gateway/auth/mcp/tool-cache.ts` - cache filtered catalog plus diagnostics, and add explicit invalidation API.
- `packages/server/src/gateway/auth/mcp/proxy.ts` - apply `toolFilter`, record quarantine diagnostics, add backoff checks, invalidate catalog on `notifications/tools/list_changed`.
- `packages/server/src/gateway/gateway/index.ts` - include MCP diagnostics in session context.
- `packages/agent-worker/src/openclaw/session-context.ts` - parse diagnostics and render concise setup/projection warnings only when useful.
- `packages/agent-worker/src/openclaw/custom-tools.ts` - consume projected MCP tools instead of raw schemas.
- `packages/agent-worker/src/openclaw/session-runner.ts` - support `mcpExposure="broker"`, call projection after provider resolution, enforce caps before registering custom tools.
- `packages/agent-worker/src/shared/tool-implementations.ts` - route `callMcpTool()` response content through the normalizer.

## Design Contract

### `toolFilter`

Add this shared type:

```ts
export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}
```

Rules:
- Empty filter means include all discovered tools.
- `include` limits the list first when present.
- `exclude` removes tools after include.
- Patterns are exact names or simple `*` globs only.
- Filter applies to discovered MCP tools and generated utility tools when those are added later.
- Filtering happens in Gateway before worker session context returns `mcpTools`.

### Schema Projection And Quarantine

Add this metadata to `McpToolDef`:

```ts
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  projection?: {
    status: "raw" | "projected" | "quarantined";
    provider?: string;
    reason?: string;
    originalHash?: string;
  };
}
```

Projection rules:
- If schema is missing, use `{ type: "object", properties: {} }`.
- If root schema is not an object schema, quarantine the tool for direct exposure.
- Remove schema keywords known to trip providers: `$schema`, `$id`, `definitions`, `$defs`, `patternProperties`, `unevaluatedProperties`, `dependentSchemas`, `dependentRequired`, `if`, `then`, `else`, `allOf`, `anyOf`, `oneOf`, `not`.
- Preserve `type`, `description`, `properties`, `required`, `enum`, `items`, `additionalProperties` when they are plain and bounded.
- Clamp recursive depth to 6. If exceeded, replace the nested node with `{ type: "string", description: "Projected from a deeply nested MCP schema." }`.
- For Gemini, keep projected direct tools only when the projected schema JSON length is <= 12 KB.
- Quarantined tools remain callable through `cli` and later through `broker`; they are not registered as first-class provider tools.

### Gemini Hard Cap

Default:

```ts
const DEFAULT_MCP_DIRECT_TOOL_LIMIT_BY_PROVIDER = {
  gemini: 24,
  default: 64,
};
```

Selection order:
- Apply `toolFilter`.
- Drop quarantined tools.
- Sort direct candidates by explicit `toolsConfig.mcpDirectAllowlist` first when added, then stable `(mcpId, toolName)`.
- For Gemini, register at most 24 MCP direct tools unless `toolsConfig.mcpDirectToolLimit` is lower.
- Log omitted counts by server and add a concise instruction warning.

### Backoff

Backoff key: `${agentId}:${mcpId}`.

State:

```ts
interface McpServerHealthState {
  consecutiveFailures: number;
  pausedUntil: number;
  lastFailureAt: number;
  lastError: string;
}
```

Rules:
- Count discovery protocol errors, `tools/list` errors, and tool-call HTTP 5xx/network errors.
- Do not count 401 OAuth-required or 403 approval-required as broken-server failures.
- Pause after 3 consecutive failures.
- First pause is 30 seconds; double up to 5 minutes.
- A successful discovery or tool call clears the failure count.
- While paused, discovery returns cached tools if available; otherwise returns no tools plus diagnostics, without blocking the whole turn.

### Result Normalization

`callMcpTool()` must never pass raw MCP blocks into provider history. Normalize to Lobu `TextResult`:
- `text` blocks keep text.
- `image` blocks with valid data/mime become a text placeholder unless the receiving tool contract supports provider images; direct MCP tools currently return text-only, so use `"[image result omitted: <mimeType>, <bytes> bytes]"`.
- `resource_link` becomes `"[resource: <name-or-uri>](<uri>)"` only for http/https URIs; otherwise plain text `resource: <uri>`.
- `audio` becomes `"[audio result omitted: <mimeType>, <bytes> bytes]"`.
- Malformed or unknown blocks become short text diagnostics and never throw.
- If normalized output is empty and `isError !== true`, return `<toolName> completed.`.

### Broker Exposure

Add `mcpExposure="broker"` after safety work is green.

First-class broker tools:
- `mcp_list_tools({ server?: string, query?: string, includeSchemas?: boolean })`
- `mcp_get_tool_schema({ server: string, tool: string })`
- `mcp_call_tool({ server: string, tool: string, args: object })`

Direct promote policy:
- Broker mode registers the three broker tools and auth tools.
- It may also promote a tiny allowlisted direct set from `toolsConfig.mcpDirectAllowlist`.
- Quarantined direct schemas are still available through `mcp_get_tool_schema` as raw JSON text, not as provider tool schemas.

## Task 1: Tracer Bullet - Quarantine Bad Schema Before Gemini Tool Registration

**Files:**
- Create: `packages/agent-worker/src/openclaw/mcp-tool-projection.ts`
- Create: `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`
- Modify: `packages/agent-worker/src/openclaw/custom-tools.ts`
- Modify: `packages/agent-worker/src/openclaw/session-runner.ts`

- [x] **Step 1: Write the failing projection tests**

Create `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { projectMcpToolsForProvider } from "../openclaw/mcp-tool-projection";

const healthy: McpToolDef = {
  name: "search",
  description: "Search docs",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const badRoot: McpToolDef = {
  name: "bad_root",
  inputSchema: { type: "array", items: { type: "string" } },
};

const unionHeavy: McpToolDef = {
  name: "union_heavy",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        anyOf: [{ type: "string" }, { type: "number" }],
      },
    },
  },
};

describe("projectMcpToolsForProvider", () => {
  test("keeps healthy object schemas and quarantines unsupported root schemas", () => {
    const projected = projectMcpToolsForProvider(
      { notion: [healthy, badRoot] },
      { provider: "gemini", directToolLimit: 24 }
    );

    expect(projected.tools.notion.map((tool) => tool.name)).toEqual(["search"]);
    expect(projected.quarantined).toContainEqual({
      mcpId: "notion",
      toolName: "bad_root",
      reason: "root schema must be an object",
    });
  });

  test("projects unsupported union keywords out of nested schemas", () => {
    const projected = projectMcpToolsForProvider(
      { google_workspace: [unionHeavy] },
      { provider: "gemini", directToolLimit: 24 }
    );

    const schema = projected.tools.google_workspace[0]?.inputSchema;
    expect(JSON.stringify(schema)).not.toContain("anyOf");
    expect(schema).toEqual({
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Projected from unsupported MCP schema union.",
        },
      },
    });
    expect(projected.projected).toContainEqual({
      mcpId: "google_workspace",
      toolName: "union_heavy",
      reason: "removed unsupported keyword anyOf",
    });
  });

  test("enforces Gemini direct MCP tool cap after quarantine", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      ...healthy,
      name: `tool_${String(index).padStart(2, "0")}`,
    }));

    const projected = projectMcpToolsForProvider(
      { bulk: many },
      { provider: "gemini", directToolLimit: 3 }
    );

    expect(projected.tools.bulk.map((tool) => tool.name)).toEqual([
      "tool_00",
      "tool_01",
      "tool_02",
    ]);
    expect(projected.omittedForCap).toEqual([
      { mcpId: "bulk", omitted: 27, limit: 3 },
    ]);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
bun test packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts
```

Expected: FAIL because `mcp-tool-projection.ts` does not exist.

- [x] **Step 3: Implement the minimal projection module**

Create `packages/agent-worker/src/openclaw/mcp-tool-projection.ts`:

```ts
import type { McpToolDef } from "@lobu/core";

export interface ProjectionNotice {
  mcpId: string;
  toolName: string;
  reason: string;
}

export interface CapNotice {
  mcpId: string;
  omitted: number;
  limit: number;
}

export interface ProjectMcpToolsOptions {
  provider: string;
  directToolLimit: number;
}

export interface ProjectedMcpTools {
  tools: Record<string, McpToolDef[]>;
  projected: ProjectionNotice[];
  quarantined: ProjectionNotice[];
  omittedForCap: CapNotice[];
}

const UNSUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "patternProperties",
  "unevaluatedProperties",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectSchemaNode(
  node: unknown,
  notices: string[],
  depth = 0
): Record<string, unknown> {
  if (!isRecord(node)) return {};
  if (depth > 6) {
    notices.push("clamped schema depth");
    return {
      type: "string",
      description: "Projected from a deeply nested MCP schema.",
    };
  }

  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) {
      notices.push(`removed unsupported keyword ${keyword}`);
      if (keyword === "anyOf" || keyword === "oneOf" || keyword === "allOf") {
        return {
          type: "string",
          description: "Projected from unsupported MCP schema union.",
        };
      }
    }
  }

  const projected: Record<string, unknown> = {};
  if (typeof node.type === "string") projected.type = node.type;
  if (typeof node.description === "string") projected.description = node.description;
  if (Array.isArray(node.enum)) projected.enum = node.enum.filter((item) => typeof item !== "object");
  if (Array.isArray(node.required)) projected.required = node.required.filter((item) => typeof item === "string");
  if (typeof node.additionalProperties === "boolean") projected.additionalProperties = node.additionalProperties;
  if (isRecord(node.properties)) {
    projected.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [
        key,
        projectSchemaNode(value, notices, depth + 1),
      ])
    );
  }
  if (isRecord(node.items)) projected.items = projectSchemaNode(node.items, notices, depth + 1);
  return projected;
}

function projectTool(mcpId: string, tool: McpToolDef): { tool?: McpToolDef; notices: ProjectionNotice[]; quarantined?: ProjectionNotice } {
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  if (!isRecord(schema) || schema.type !== "object") {
    return {
      notices: [],
      quarantined: {
        mcpId,
        toolName: tool.name,
        reason: "root schema must be an object",
      },
    };
  }

  const reasons: string[] = [];
  const inputSchema = projectSchemaNode(schema, reasons);
  if (!inputSchema.type) inputSchema.type = "object";
  if (!isRecord(inputSchema.properties)) inputSchema.properties = {};

  return {
    tool: { ...tool, inputSchema },
    notices: Array.from(new Set(reasons)).map((reason) => ({
      mcpId,
      toolName: tool.name,
      reason,
    })),
  };
}

export function projectMcpToolsForProvider(
  mcpTools: Record<string, McpToolDef[]>,
  options: ProjectMcpToolsOptions
): ProjectedMcpTools {
  const result: ProjectedMcpTools = {
    tools: {},
    projected: [],
    quarantined: [],
    omittedForCap: [],
  };

  let remaining = Math.max(0, options.directToolLimit);
  for (const [mcpId, tools] of Object.entries(mcpTools).sort(([a], [b]) => a.localeCompare(b))) {
    const accepted: McpToolDef[] = [];
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const projected = projectTool(mcpId, tool);
      if (projected.quarantined) {
        result.quarantined.push(projected.quarantined);
        continue;
      }
      result.projected.push(...projected.notices);
      if (projected.tool && remaining > 0) {
        accepted.push(projected.tool);
        remaining -= 1;
      }
    }
    if (accepted.length > 0) result.tools[mcpId] = accepted;
    const safeCount = tools.length - result.quarantined.filter((q) => q.mcpId === mcpId).length;
    const omitted = Math.max(0, safeCount - accepted.length);
    if (omitted > 0) {
      result.omittedForCap.push({ mcpId, omitted, limit: options.directToolLimit });
    }
  }
  return result;
}
```

- [x] **Step 4: Run the projection test until green**

Run:

```bash
bun test packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts
```

Expected: PASS.

- [x] **Step 5: Wire projection into session runner**

In `packages/agent-worker/src/openclaw/session-runner.ts`, after provider resolution and before `createMcpToolDefinitions()`, compute:

```ts
const providerDirectToolLimit =
  rawProvider === "gemini"
    ? Math.min(
        Number((rawOptions.toolsConfig as ToolsConfig | undefined)?.mcpDirectToolLimit ?? 24),
        24
      )
    : Number((rawOptions.toolsConfig as ToolsConfig | undefined)?.mcpDirectToolLimit ?? 64);
const projectedMcp = projectMcpToolsForProvider(context.mcpTools, {
  provider: rawProvider,
  directToolLimit: providerDirectToolLimit,
});
```

Then pass `projectedMcp.tools` to `createMcpToolDefinitions()`. Log `projectedMcp.quarantined`, `projectedMcp.projected`, and `projectedMcp.omittedForCap` by counts and tool names.

- [x] **Step 6: Commit the tracer bullet**

Run:

```bash
git add packages/agent-worker/src/openclaw/mcp-tool-projection.ts packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts packages/agent-worker/src/openclaw/session-runner.ts
git commit -m "feat(worker): project mcp schemas before direct exposure"
```

## Task 2: Add Per-Server `toolFilter`

**Files:**
- Create: `packages/core/src/utils/mcp-tool-filter.ts`
- Create: `packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/gateway/auth/mcp/config-service.ts`
- Modify: `packages/server/src/gateway/auth/mcp/proxy.ts`

- [x] **Step 1: Write filter tests**

Create `packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyMcpToolFilter } from "@lobu/core";

describe("applyMcpToolFilter", () => {
  const tools = [
    { name: "search" },
    { name: "read_page" },
    { name: "delete_page" },
    { name: "resources_list" },
  ];

  test("includes all tools when filter is empty", () => {
    expect(applyMcpToolFilter(tools, undefined).map((t) => t.name)).toEqual([
      "search",
      "read_page",
      "delete_page",
      "resources_list",
    ]);
  });

  test("applies include before exclude with exact and star globs", () => {
    expect(
      applyMcpToolFilter(tools, {
        include: ["*_page", "resources_*"],
        exclude: ["delete_*"],
      }).map((t) => t.name)
    ).toEqual(["read_page", "resources_list"]);
  });
});
```

- [x] **Step 2: Run the failing test**

Run:

```bash
bun test packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts
```

Expected: FAIL because `applyMcpToolFilter` is not exported.

- [x] **Step 3: Implement and export the filter**

Create `packages/core/src/utils/mcp-tool-filter.ts`:

```ts
export interface McpToolFilter {
  include?: string[];
  exclude?: string[];
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

function matchesAny(name: string, patterns: string[] | undefined): boolean {
  return Boolean(patterns?.some((pattern) => matchesPattern(name, pattern)));
}

export function applyMcpToolFilter<T extends { name: string }>(
  tools: T[],
  filter?: McpToolFilter
): T[] {
  const include = filter?.include?.filter(Boolean);
  const exclude = filter?.exclude?.filter(Boolean);
  return tools.filter((tool) => {
    if (include?.length && !matchesAny(tool.name, include)) return false;
    if (exclude?.length && matchesAny(tool.name, exclude)) return false;
    return true;
  });
}
```

Export it from `packages/core/src/index.ts` and add `toolFilter?: McpToolFilter` to both `McpServerConfig` and `SkillMcpServer`.

- [x] **Step 4: Preserve filter in config-service normalization**

In `packages/server/src/gateway/auth/mcp/config-service.ts`, include `toolFilter` when normalizing MCP server configs into `HttpMcpServerConfig`. Add a local type field:

```ts
toolFilter?: McpToolFilter;
```

- [x] **Step 5: Apply filter in proxy discovery**

In `fetchToolsForMcp()`, after `const tools: McpTool[] = data?.result?.tools || [];`, compute:

```ts
const filteredTools = applyMcpToolFilter(tools, httpServer.toolFilter);
```

Cache and return `filteredTools`, not raw `tools`.

- [x] **Step 6: Run focused tests**

Run:

```bash
bun test packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts packages/server/src/gateway/__tests__/mcp-proxy.test.ts packages/server/src/gateway/__tests__/mcp-proxy-edge-cases.test.ts
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts packages/core/src/utils/mcp-tool-filter.ts packages/server/src/gateway/auth/mcp/config-service.ts packages/server/src/gateway/auth/mcp/proxy.ts packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts
git commit -m "feat(gateway): filter mcp tools before worker projection"
```

## Task 3: Add Catalog Cache Invalidation And Broken-Server Backoff

**Files:**
- Create: `packages/server/src/gateway/auth/mcp/server-health.ts`
- Create: `packages/server/src/gateway/__tests__/mcp-server-health.test.ts`
- Modify: `packages/server/src/gateway/auth/mcp/tool-cache.ts`
- Modify: `packages/server/src/gateway/auth/mcp/proxy.ts`

- [ ] **Step 1: Write health-state tests**

Create `packages/server/src/gateway/__tests__/mcp-server-health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { McpServerHealth } from "../auth/mcp/server-health";

describe("McpServerHealth", () => {
  test("pauses a server after three consecutive failures and clears on success", () => {
    const health = new McpServerHealth(() => 1000);
    health.recordFailure("agent:mcp", "boom 1");
    health.recordFailure("agent:mcp", "boom 2");
    expect(health.getPause("agent:mcp")).toBeNull();
    health.recordFailure("agent:mcp", "boom 3");
    expect(health.getPause("agent:mcp")).toEqual({
      pausedUntil: 31_000,
      lastError: "boom 3",
    });
    health.recordSuccess("agent:mcp");
    expect(health.getPause("agent:mcp")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement server health**

Create `packages/server/src/gateway/auth/mcp/server-health.ts`:

```ts
interface State {
  consecutiveFailures: number;
  pausedUntil: number;
  lastFailureAt: number;
  lastError: string;
  pauseMs: number;
}

export class McpServerHealth {
  private readonly states = new Map<string, State>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  getPause(key: string): { pausedUntil: number; lastError: string } | null {
    const state = this.states.get(key);
    if (!state) return null;
    if (state.pausedUntil <= this.now()) return null;
    return { pausedUntil: state.pausedUntil, lastError: state.lastError };
  }

  recordFailure(key: string, error: string): void {
    const previous = this.states.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const previousPause = previous?.pauseMs ?? 15_000;
    const pauseMs = consecutiveFailures >= 3 ? Math.min(previousPause * 2, 300_000) : previousPause;
    this.states.set(key, {
      consecutiveFailures,
      pausedUntil: consecutiveFailures >= 3 ? this.now() + pauseMs : 0,
      lastFailureAt: this.now(),
      lastError: error,
      pauseMs,
    });
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }
}
```

- [ ] **Step 3: Add explicit cache invalidation**

In `McpToolCache`, add:

```ts
delete(mcpId: string, agentId?: string): void {
  this.entries.delete(this.buildKey(mcpId, agentId));
}
```

- [ ] **Step 4: Wire health into proxy**

In `McpProxy`, instantiate `private readonly serverHealth = new McpServerHealth();`. At the top of `fetchToolsForMcp()`, after cache lookup:

```ts
const healthKey = `${agentId}:${mcpId}`;
const pause = this.serverHealth.getPause(healthKey);
if (pause) {
  logger.warn("Skipping MCP tool discovery while server is paused", { mcpId, agentId, pausedUntil: pause.pausedUntil, lastError: pause.lastError });
  return { tools: [] };
}
```

Call `recordSuccess(healthKey)` after successful `tools/list`; call `recordFailure(healthKey, message)` after discovery failures except 401 and 403.

- [ ] **Step 5: Invalidate on dynamic tool-list notification**

In the MCP streamable HTTP response handling path, detect JSON-RPC method `notifications/tools/list_changed`. When seen:

```ts
this.toolCache?.delete(mcpId, agentId);
logger.info("Invalidated MCP tool cache after tools/list_changed", { mcpId, agentId });
```

- [ ] **Step 6: Run focused tests**

```bash
bun test packages/server/src/gateway/__tests__/mcp-server-health.test.ts packages/server/src/gateway/__tests__/mcp-proxy.test.ts packages/server/src/gateway/__tests__/mcp-proxy-edge-cases.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/gateway/auth/mcp/server-health.ts packages/server/src/gateway/auth/mcp/tool-cache.ts packages/server/src/gateway/auth/mcp/proxy.ts packages/server/src/gateway/__tests__/mcp-server-health.test.ts
git commit -m "feat(gateway): pause broken mcp servers during discovery"
```

## Task 4: Normalize MCP Results Before Provider History

**Files:**
- Create: `packages/agent-worker/src/openclaw/mcp-result-normalizer.ts`
- Create: `packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts`
- Modify: `packages/agent-worker/src/shared/tool-implementations.ts`
- Modify: `packages/agent-worker/src/__tests__/mcp-tool-call.test.ts`

- [ ] **Step 1: Write normalizer tests**

Create `packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeMcpResultContent } from "../openclaw/mcp-result-normalizer";

describe("normalizeMcpResultContent", () => {
  test("keeps text and projects resource links", () => {
    expect(
      normalizeMcpResultContent([
        { type: "text", text: "hello" },
        { type: "resource_link", uri: "https://example.com/a", name: "doc" },
      ])
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "[resource: doc](https://example.com/a)" },
    ]);
  });

  test("turns audio and malformed image blocks into safe text", () => {
    expect(
      normalizeMcpResultContent([
        { type: "audio", mimeType: "audio/wav", data: "YWJj" },
        { type: "image", data: 123 },
      ])
    ).toEqual([
      { type: "text", text: "[audio result omitted: audio/wav, 3 bytes]" },
      { type: "text", text: "[malformed image result omitted]" },
    ]);
  });
});
```

- [ ] **Step 2: Implement normalizer**

Create `packages/agent-worker/src/openclaw/mcp-result-normalizer.ts`:

```ts
export interface NormalizedTextBlock {
  type: "text";
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesFromBase64(value: string): number {
  return Buffer.byteLength(value, "base64");
}

function safeResourceText(block: Record<string, unknown>): string {
  const uri = typeof block.uri === "string" ? block.uri : "";
  const name = typeof block.name === "string" && block.name.trim() ? block.name.trim() : uri;
  if (/^https?:\/\//i.test(uri)) return `[resource: ${name}](${uri})`;
  return `resource: ${uri || "unknown"}`;
}

export function normalizeMcpResultContent(content: unknown): NormalizedTextBlock[] {
  if (!Array.isArray(content)) return [];
  return content.map((block): NormalizedTextBlock => {
    if (!isRecord(block)) return { type: "text", text: "[malformed MCP result block omitted]" };
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "resource_link") return { type: "text", text: safeResourceText(block) };
    if (block.type === "audio") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown";
      const data = typeof block.data === "string" ? block.data : "";
      return { type: "text", text: `[audio result omitted: ${mime}, ${bytesFromBase64(data)} bytes]` };
    }
    if (block.type === "image") {
      if (typeof block.data !== "string") return { type: "text", text: "[malformed image result omitted]" };
      const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown";
      return { type: "text", text: `[image result omitted: ${mime}, ${bytesFromBase64(block.data)} bytes]` };
    }
    return { type: "text", text: `[unsupported MCP result block omitted: ${String(block.type ?? "unknown")}]` };
  });
}
```

- [ ] **Step 3: Use the normalizer in `callMcpTool()`**

In `packages/agent-worker/src/shared/tool-implementations.ts`, import `normalizeMcpResultContent` and replace manual `data.content.filter((c) => c.type === "text")` handling with:

```ts
const normalizedContent = normalizeMcpResultContent(data.content);
const contentText = normalizedContent.map((c) => c.text).join("\n");
```

Return `content: normalizedContent.length > 0 ? normalizedContent : [{ type: "text", text: `${toolName} completed.` }]`.

- [ ] **Step 4: Run focused tests**

```bash
bun test packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts packages/agent-worker/src/__tests__/mcp-tool-call.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-worker/src/openclaw/mcp-result-normalizer.ts packages/agent-worker/src/shared/tool-implementations.ts packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts packages/agent-worker/src/__tests__/mcp-tool-call.test.ts
git commit -m "fix(worker): normalize mcp results before model history"
```

## Task 5: Add Broker Exposure Mode

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/agent-worker/src/openclaw/custom-tools.ts`
- Modify: `packages/agent-worker/src/openclaw/session-context.ts`
- Modify: `packages/agent-worker/src/openclaw/session-runner.ts`
- Add tests in `packages/agent-worker/src/__tests__/mcp-broker-tools.test.ts`

- [ ] **Step 1: Extend exposure type**

Change:

```ts
mcpExposure?: "tools" | "cli";
```

to:

```ts
mcpExposure?: "tools" | "cli" | "broker";
```

- [ ] **Step 2: Add broker tool tests**

Create tests asserting:
- `mcp_list_tools` lists tool names without schemas by default.
- `mcp_get_tool_schema` returns raw schema text for a quarantined tool.
- `mcp_call_tool` delegates to `callMcpTool()`.
- `mcpExposure="broker"` registers exactly broker tools plus auth tools, not every MCP tool.

- [ ] **Step 3: Implement broker tool definitions**

Add `createMcpBrokerToolDefinitions()` in `custom-tools.ts` with TypeBox parameters:

```ts
mcp_list_tools({ server?: string, query?: string, includeSchemas?: boolean })
mcp_get_tool_schema({ server: string, tool: string })
mcp_call_tool({ server: string, tool: string, args: Record<string, unknown> })
```

Use `context.mcpTools` as the local catalog and `callMcpTool()` for execution.

- [ ] **Step 4: Wire broker mode in session runner**

When `mcpExposure === "broker"`:
- Do not call `createMcpToolDefinitions()` for every MCP tool.
- Register `createMcpBrokerToolDefinitions(context.mcpTools, gwParams)`.
- Register auth tools.
- Keep CLI disabled unless `mcpExposure === "cli"`.

- [ ] **Step 5: Run focused tests**

```bash
bun test packages/agent-worker/src/__tests__/mcp-broker-tools.test.ts packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts packages/agent-worker/src/__tests__/mcp-tool-call.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/agent-worker/src/openclaw/custom-tools.ts packages/agent-worker/src/openclaw/session-context.ts packages/agent-worker/src/openclaw/session-runner.ts packages/agent-worker/src/__tests__/mcp-broker-tools.test.ts
git commit -m "feat(worker): add broker mcp exposure mode"
```

## Task 6: End-To-End Verification And Production Guardrails

**Files:**
- Modify or add focused tests only if gaps are found.
- Update this plan's checklist as tasks land.

- [ ] **Step 1: Run worker tests**

```bash
bun test \
  packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts \
  packages/agent-worker/src/__tests__/mcp-result-normalizer.test.ts \
  packages/agent-worker/src/__tests__/mcp-tool-call.test.ts \
  packages/agent-worker/src/__tests__/mcp-cli-commands.test.ts \
  packages/agent-worker/src/__tests__/model-resolver.test.ts \
  packages/agent-worker/src/__tests__/model-resolver-harden.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run gateway MCP tests**

```bash
bun test \
  packages/server/src/gateway/__tests__/mcp-tool-filter.test.ts \
  packages/server/src/gateway/__tests__/mcp-server-health.test.ts \
  packages/server/src/gateway/__tests__/mcp-proxy.test.ts \
  packages/server/src/gateway/__tests__/mcp-proxy-edge-cases.test.ts \
  packages/server/src/gateway/__tests__/worker-gateway-session-context.test.ts
```

Expected: PASS.

- [ ] **Step 3: Build packages**

```bash
make build-packages
```

Expected: PASS.

- [ ] **Step 4: Manual local smoke**

Run a local worker session with:
- `toolsConfig.mcpExposure = "tools"`
- provider Gemini
- one fake MCP with 30 simple tools
- one fake MCP with `anyOf`
- one fake MCP with array-root schema

Expected:
- first-class direct MCP tools <= 24
- array-root schema tool omitted from direct tool list
- union schema projected without `anyOf`
- CLI mode still exposes the server command and `--schema`
- broker mode exposes `mcp_list_tools`, `mcp_get_tool_schema`, `mcp_call_tool`

- [ ] **Step 5: Production safety check**

Confirm current LINE personal-agent settings still use `mcpExposure=cli` before deployment. Do not change production exposure in this PR.

- [ ] **Step 6: Final commit**

```bash
git status --short
git log --oneline --max-count=8
```

Expected: only intended commits are present.

## Rollout

1. Merge safety layer with production still on `mcpExposure=cli`.
2. Deploy Lobu through the existing GitHub Actions image build -> GHCR -> Zeabur image path.
3. Smoke LINE Gateway against staging Toolbox and active Lobu health.
4. Enable `mcpExposure=broker` for one canary personal agent.
5. Enable `mcpExposure=tools` only for allowlisted servers with small direct caps.

## Self-Review

- Spec coverage: Covers `toolFilter`, schema quarantine/projection, Gemini hard cap, session catalog cache invalidation, broken-server backoff, result normalization, and broker mode.
- Tracer bullet: Task 1 proves the riskiest path first: bad MCP schema no longer reaches Gemini direct tool registration.
- Placeholder scan: No `TBD`, generic "add tests", or unspecified implementation-only steps remain.
- Type consistency: `McpToolFilter`, `McpToolDef.projection`, and `mcpExposure` values are named consistently across tasks.
