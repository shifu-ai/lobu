# Global Tool Name Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent provider request failures caused by duplicate final tool/function names across OpenClaw built-ins, Toolbox personal-agent connector tools, first-class MCP tools, MCP auth tools, and plugin tools.

**Architecture:** Build one provider-facing tool-name registry for each OpenClaw session and seed it with names that are already exposed before later tool groups are projected or appended. MCP direct tool projection must reserve against existing custom tools, and the final provider tool surface must be asserted unique before the model request is built.

**Tech Stack:** TypeScript, Bun test, OpenClaw worker, Gemini/Google provider-safe tool-name projection, Lobu gateway session context.

---

## Problem Statement

On 2026-06-25, the LINE PM agent failed only when the user asked it to call tools. Temporarily switching the live agent from `mcpExposure: "cli"` back to first-class MCP reproduced a Gemini provider error:

```text
Duplicate function declaration found: notion_search
```

The duplicate comes from two different tool sources:

- `packages/server/src/gateway/gateway/index.ts` exposes a Toolbox personal-agent Notion connector tool named `notion_search`, backed by connector upstream `notion-search`.
- `packages/agent-worker/src/openclaw/mcp-tool-projection.ts` projects the first-class MCP upstream tool `notion-search` to Gemini-safe `notion_search`.

Existing MCP projection protects MCP tools against each other, but it does not know about names that `createOpenClawCustomTools()` already added to `customTools`. The invariant must move from "MCP-local tool names are safe" to "the final provider-facing tool list is globally unique".

## Files

- Modify: `packages/agent-worker/src/openclaw/mcp-tool-projection.ts`
  - Add a way to seed MCP direct tool-name projection with names already claimed by earlier tool groups.
- Modify: `packages/agent-worker/src/openclaw/session-runner.ts`
  - Seed MCP projection with existing `customTools` names before first-class MCP tools are appended.
  - Keep MCP auth tool naming seeded from the current `customTools` names.
  - Add a final uniqueness assertion before provider request construction.
- Modify: `packages/agent-worker/src/openclaw/custom-tools.ts`
  - Only if needed, expose a small helper for collecting tool names or for filtering duplicated appended tools.
- Modify: `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`
  - Cover MCP projection with pre-reserved provider names.
- Modify: `packages/agent-worker/src/__tests__/embedded-tools.test.ts`
  - Cover `createMcpToolDefinitions()` routing when a projected MCP tool has been suffixed due to a pre-reserved name.
- Modify: `packages/agent-worker/src/__tests__/custom-tools.test.ts`
  - Cover the exact `Toolbox personal-agent notion_search + MCP notion-search` collision as a worker-level tool assembly regression if this seam is practical.

## Naming Policy

Provider-facing names must be unique across the final tool array sent to the model.

When a collision exists, prefer preserving the name that was registered earlier in the current session assembly order. For the current assembly order, Toolbox personal-agent tools are created by `createOpenClawCustomTools()` before first-class MCP tools, so `notion_search` remains the Toolbox personal tool and the MCP direct tool should be projected to a deterministic suffixed name such as `notion_search_2`.

The suffixed MCP tool must still execute the original upstream MCP tool name, for example:

```text
provider-facing function: notion_search_2
MCP server id: notion
upstream MCP tool: notion-search
```

Auth tools already receive `existingToolNames`; keep that behavior and make the MCP direct tool path equally explicit.

## Task 1: Reproduce Cross-Source Duplicate At The Projection Boundary

**Files:**

- Modify: `packages/agent-worker/src/openclaw/mcp-tool-projection.ts`
- Test: `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `describe("projectMcpToolsForProvider", ...)` in `packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts`:

```ts
  test("reserves existing provider tool names before projecting Gemini MCP names", () => {
    const projected = projectMcpToolsForProvider(
      {
        notion: [
          {
            name: "notion-search",
            description: "Search Notion",
            inputSchema: { type: "object" },
          },
        ],
      },
      {
        provider: "gemini",
        directToolLimit: 3,
        reservedProviderToolNames: new Set(["notion_search"]),
      }
    );

    expect(projected.tools.notion?.[0]).toMatchObject({
      name: "notion_search_2",
      upstreamToolName: "notion-search",
      providerToolName: "notion_search_2",
      providerSafeNameOnly: true,
    });
    expect(projected.omittedForCap).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts -t "reserves existing provider tool names before projecting Gemini MCP names"
```

Expected: FAIL because `ProjectMcpToolsOptions` does not accept `reservedProviderToolNames`, or because the MCP tool still projects to `notion_search`.

- [ ] **Step 3: Add the minimal projection option**

In `packages/agent-worker/src/openclaw/mcp-tool-projection.ts`, extend `ProjectMcpToolsOptions`:

```ts
type ProjectMcpToolsOptions = {
  provider: string;
  directToolLimit: number;
  reservedProviderToolNames?: Set<string>;
};
```

Then seed the projection-local reserved set from the option:

```ts
  const reservedProviderToolNames = new Set(
    options.reservedProviderToolNames ?? []
  );
```

Keep this line inside `projectToolNameForProvider()`:

```ts
  reservedProviderToolNames.add(providerToolName);
```

This preserves the existing behavior where each accepted or omitted MCP candidate consumes its generated provider-safe name during projection, preventing later MCP tools from reusing it.

- [ ] **Step 4: Run the focused test**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts -t "reserves existing provider tool names before projecting Gemini MCP names"
```

Expected: PASS.

- [ ] **Step 5: Run the projection test file**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-worker/src/openclaw/mcp-tool-projection.ts packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts
git commit -m "fix(worker): reserve existing names during mcp projection"
```

## Task 2: Preserve MCP Upstream Routing After Collision Suffixing

**Files:**

- Test: `packages/agent-worker/src/__tests__/embedded-tools.test.ts`

- [ ] **Step 1: Write the routing regression test**

Add this test near the existing projected Gemini `notion-search` test in `packages/agent-worker/src/__tests__/embedded-tools.test.ts`:

```ts
  test("executes upstream MCP name when Gemini projection is suffixed by reserved names", async () => {
    const originalFetch = globalThis.fetch;
    const capturedUrls: string[] = [];
    globalThis.fetch = async (url: Parameters<typeof fetch>[0]) => {
      capturedUrls.push(typeof url === "string" ? url : url.toString());
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "notion result" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const projected = projectMcpToolsForProvider(
      {
        notion: [{ name: "notion-search", description: "Search Notion" }],
      },
      {
        provider: "gemini",
        directToolLimit: 3,
        reservedProviderToolNames: new Set(["notion_search"]),
      }
    );

    try {
      const defs = createMcpToolDefinitions(projected.tools, gw);
      expect(defs.map((def) => def.name)).toEqual(["notion_search_2"]);

      await defs[0].execute(
        "call-id",
        { query: "budget" },
        undefined,
        undefined,
        {} as any
      );

      expect(capturedUrls).toEqual([
        "http://gateway:8080/mcp/notion/tools/notion-search",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
```

- [ ] **Step 2: Run the focused routing test**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/embedded-tools.test.ts -t "executes upstream MCP name when Gemini projection is suffixed by reserved names"
```

Expected: PASS after Task 1.

- [ ] **Step 3: Run the embedded tools test file**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/embedded-tools.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-worker/src/__tests__/embedded-tools.test.ts
git commit -m "test(worker): preserve suffixed mcp upstream routing"
```

## Task 3: Seed MCP Projection From Existing Session Custom Tools

**Files:**

- Modify: `packages/agent-worker/src/openclaw/session-runner.ts`
- Test: `packages/agent-worker/src/__tests__/custom-tools.test.ts`

- [ ] **Step 1: Add a final duplicate-name helper test**

If importing `runOpenClawSession` is too heavy for a unit test, keep this as a focused assembly-style test in `packages/agent-worker/src/__tests__/custom-tools.test.ts` using the same functions as the runtime path:

```ts
import {
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "../openclaw/custom-tools";
import { projectMcpToolsForProvider } from "../openclaw/mcp-tool-projection";
```

Add:

```ts
  test("keeps Toolbox personal Notion tool and first-class MCP Notion tool globally unique for Gemini", () => {
    const gw = {
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent",
      userId: "toolbox-user",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    };

    const customTools = createOpenClawCustomTools({
      ...gw,
      toolboxPersonalAgentTools: [
        {
          connectorKey: "notion",
          connectionRef: "toolbox-mcp:ref",
          tools: [
            {
              name: "notion_search",
              connectorToolName: "notion-search",
              description:
                "Search Notion pages and databases available to the connected Toolbox user.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "number" },
                },
                required: ["query"],
              },
            },
          ],
        },
      ],
    });

    const projectedMcp = projectMcpToolsForProvider(
      {
        notion: [
          {
            name: "notion-search",
            description: "Search Notion MCP",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
      {
        provider: "gemini",
        directToolLimit: 100,
        reservedProviderToolNames: new Set(customTools.map((tool) => tool.name)),
      }
    );

    const mcpToolDefs = createMcpToolDefinitions(projectedMcp.tools, gw);
    const names = [...customTools, ...mcpToolDefs].map((tool) => tool.name);
    expect(names.filter((name) => name === "notion_search")).toHaveLength(1);
    expect(names).toContain("notion_search_2");
    expect(new Set(names).size).toBe(names.length);
  });
```

- [ ] **Step 2: Run the test to verify current runtime assembly would fail without seeding**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/custom-tools.test.ts -t "keeps Toolbox personal Notion tool and first-class MCP Notion tool globally unique for Gemini"
```

Expected after Task 1: PASS for the focused helper path. If it fails because the test file lacks imports, add the imports shown in Step 1.

- [ ] **Step 3: Seed projection in the real session runner path**

In `packages/agent-worker/src/openclaw/session-runner.ts`, change:

```ts
    const projectedMcp = projectMcpToolsForProvider(context.mcpTools, {
      provider: rawProvider,
      directToolLimit: providerDirectToolLimit,
    });
```

to:

```ts
    const projectedMcp = projectMcpToolsForProvider(context.mcpTools, {
      provider: rawProvider,
      directToolLimit: providerDirectToolLimit,
      reservedProviderToolNames: new Set(customTools.map((tool) => tool.name)),
    });
```

This is the critical runtime fix. It makes MCP projection reserve names already claimed by built-ins and Toolbox personal-agent connector tools.

- [ ] **Step 4: Run the focused custom tools test**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/custom-tools.test.ts -t "keeps Toolbox personal Notion tool and first-class MCP Notion tool globally unique for Gemini"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-worker/src/openclaw/session-runner.ts packages/agent-worker/src/__tests__/custom-tools.test.ts
git commit -m "fix(worker): reserve custom tool names before mcp registration"
```

## Task 4: Add A Final Provider Tool Surface Assertion

**Files:**

- Modify: `packages/agent-worker/src/openclaw/session-runner.ts`
- Test: `packages/agent-worker/src/__tests__/custom-tools.test.ts`

- [ ] **Step 1: Add a helper for duplicate detection**

In `packages/agent-worker/src/openclaw/session-runner.ts`, add a local helper near the other session-runner helpers:

```ts
function findDuplicateToolNames(
  tools: Array<{ name?: string }>
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }));
}
```

- [ ] **Step 2: Assert uniqueness before the model session is created**

After:

```ts
  tools = projectToolParametersForProvider(tools, rawProvider);
  customTools = projectToolParametersForProvider(customTools, rawProvider);
```

add:

```ts
  const duplicateToolNames = findDuplicateToolNames([...tools, ...customTools]);
  if (duplicateToolNames.length > 0) {
    const summary = duplicateToolNames
      .map((entry) => `${entry.name} x${entry.count}`)
      .join(", ");
    throw new Error(`Duplicate provider tool names after projection: ${summary}`);
  }
```

This turns provider-specific 400 errors into a local worker invariant violation with an actionable message.

- [ ] **Step 3: Export only if tests need direct access**

If no practical test seam reaches the helper without running the full model session, export the helper:

```ts
export function findDuplicateToolNames(
  tools: Array<{ name?: string }>
): Array<{ name: string; count: number }> {
```

Then test it from `packages/agent-worker/src/__tests__/custom-tools.test.ts`:

```ts
  test("detects duplicate provider tool names before model request construction", () => {
    expect(
      findDuplicateToolNames([
        { name: "notion_search" },
        { name: "trial_sessions_list" },
        { name: "notion_search" },
      ])
    ).toEqual([{ name: "notion_search", count: 2 }]);
  });
```

- [ ] **Step 4: Run focused duplicate assertion test**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src/__tests__/custom-tools.test.ts -t "detects duplicate provider tool names before model request construction"
```

Expected: PASS.

- [ ] **Step 5: Run worker tests touched by this plan**

Run:

```bash
/Users/hua/.bun/bin/bun test \
  packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts \
  packages/agent-worker/src/__tests__/embedded-tools.test.ts \
  packages/agent-worker/src/__tests__/custom-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-worker/src/openclaw/session-runner.ts packages/agent-worker/src/__tests__/custom-tools.test.ts
git commit -m "test(worker): assert provider tool names are unique"
```

## Task 5: Verify Against The Original Failure Mode

**Files:**

- No code files required.

- [ ] **Step 1: Run the minimal local repro harness**

Run:

```bash
/Users/hua/.bun/bin/bun --eval '
import { createOpenClawCustomTools, createMcpToolDefinitions } from "./packages/agent-worker/src/openclaw/custom-tools";
import { projectMcpToolsForProvider } from "./packages/agent-worker/src/openclaw/mcp-tool-projection";

const gw = { gatewayUrl:"http://gateway", workerToken:"token", agentId:"agent", userId:"user", channelId:"ch", conversationId:"conv", platform:"line", workspaceDir:"/tmp" };
const customTools = createOpenClawCustomTools({ ...gw, toolboxPersonalAgentTools: [{ connectorKey:"notion", connectionRef:"ref", tools:[{ name:"notion_search", connectorToolName:"notion-search", description:"Search Notion", inputSchema:{ type:"object", properties:{ query:{ type:"string" } }, required:["query"] } }] }] });
const projected = projectMcpToolsForProvider({ notion: [{ name:"notion-search", description:"Search Notion MCP", inputSchema:{ type:"object", properties:{ query:{ type:"string" } }, required:["query"] } }] }, { provider:"google", directToolLimit:100, reservedProviderToolNames:new Set(customTools.map((tool) => tool.name)) });
const mcpDefs = createMcpToolDefinitions(projected.tools, gw, undefined);
const names = [...customTools, ...mcpDefs].map(t => t.name);
const counts = Object.fromEntries([...new Set(names)].map(n => [n, names.filter(x => x === n).length]).filter(([,c]) => c > 1));
console.log(JSON.stringify({ mcpDefNames: mcpDefs.map(t=>t.name), customNotionNames: customTools.map(t=>t.name).filter(n => n.includes("notion")), duplicateCounts: counts }, null, 2));
'
```

Expected:

```json
{
  "mcpDefNames": ["notion_search_2"],
  "customNotionNames": ["notion_search"],
  "duplicateCounts": {}
}
```

- [ ] **Step 2: Run focused worker test group**

Run:

```bash
/Users/hua/.bun/bin/bun test \
  packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts \
  packages/agent-worker/src/__tests__/embedded-tools.test.ts \
  packages/agent-worker/src/__tests__/custom-tools.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package-level worker tests if time allows**

Run:

```bash
/Users/hua/.bun/bin/bun test packages/agent-worker/src
```

Expected: PASS. If this is too slow or fails due unrelated environment dependencies, record the exact failing test names and keep the focused test group as the merge gate for this bug fix.

- [ ] **Step 4: Clean worker build artifacts if code under `packages/agent-worker` changed**

Run:

```bash
make clean-workers
```

Expected: command completes without leaving active worker subprocesses.

- [ ] **Step 5: Commit verification notes if this plan is implemented in the same branch**

If the implementation PR includes a plan update, append a short "Verification" section to this file with the exact commands run and their results, then commit:

```bash
git add docs/superpowers/plans/2026-06-25-global-tool-name-registry.md
git commit -m "docs(worker): document global tool name verification"
```

## Deployment Notes

Do not manually deploy Lobu from a local checkout. After code review, Lobu runtime deployment must follow the Agent Stack rule:

```text
GitHub Actions image build -> GHCR image -> Zeabur lobu-image service update
```

Before any live smoke changes `mcpExposure` back to first-class MCP, verify the running image revision and keep a rollback path to `mcpExposure: "cli"` for the active `shifu-u-*` agent.

## Verification

Completed on 2026-06-25 in worktree `/Users/hua/spike-lobu-line/lobu/.claude/worktrees/global-tool-name-registry`.

- Minimal local repro harness: passed. `customNotionNames` returned `["notion_search"]`, MCP definitions returned `["notion_search_2"]`, and `duplicateCounts` returned `{}`.
- Focused worker tests: passed with 56 tests, 0 failures.

```bash
/Users/hua/.bun/bin/bun test \
  packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts \
  packages/agent-worker/src/__tests__/embedded-tools.test.ts \
  packages/agent-worker/src/__tests__/custom-tools.test.ts
```

- Targeted Biome check for touched files: passed with no fixes applied.

```bash
/Users/hua/.bun/bin/bunx biome check --config-path config/biome.config.json \
  packages/agent-worker/src/openclaw/session-runner.ts \
  packages/agent-worker/src/openclaw/mcp-tool-projection.ts \
  packages/agent-worker/src/__tests__/mcp-tool-projection.test.ts \
  packages/agent-worker/src/__tests__/embedded-tools.test.ts \
  packages/agent-worker/src/__tests__/custom-tools.test.ts
```

- Root TypeScript check: passed.

```bash
/Users/hua/.bun/bin/bun run typecheck
```

## Self-Review

- Spec coverage: The plan covers the observed duplicate `notion_search`, the cross-source root cause, MCP projection seeding, upstream routing, final uniqueness assertion, tests, and deployment caution.
- Tracer bullet check: Task 1 is the smallest central path: projection receives an existing provider name and must suffix the MCP tool. Task 2 verifies execution still routes to the upstream MCP name.
- Placeholder scan: No placeholder marker or unspecified test step remains.
- Type consistency: The new option name is consistently `reservedProviderToolNames`; projected tool fields remain `upstreamToolName`, `providerToolName`, and `providerSafeNameOnly`.
