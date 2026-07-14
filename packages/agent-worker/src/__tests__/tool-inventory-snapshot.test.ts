import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { initializeExternalTurnToolRouting } from "../openclaw/session-runner";
import { resolveReleaseAwareToolRouterMode } from "../openclaw/session-runner";
import {
  clearToolInventorySnapshotCacheForTests,
  snapshotToolsByMcp,
  toolInventorySnapshotCacheStats,
} from "../openclaw/tool-inventory-snapshot";
import { clearToolRetrievalIndexCacheForTests } from "../openclaw/tool-retrieval-index";
import {
  clearToolRouterRetainedMemoryForTests,
  toolRouterRetainedMemoryStats,
} from "../openclaw/tool-router-memory-budget";

function tool(name: string, description: string): McpToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Original query" },
      },
    },
  };
}

const UNPAIRED_HIGH = "bad\ud800";
const UNPAIRED_LOW = "bad\udfff";

describe("external-turn immutable tool inventory snapshots", () => {
  test("raw descriptor snapshots remain content-addressed across releases", () => {
    clearToolInventorySnapshotCacheForTests();
    const source = { source: [tool("search", "Search")] };
    const first = snapshotToolsByMcp(source);
    const same = snapshotToolsByMcp(source);

    expect(same).toBe(first);
    expect(toolInventorySnapshotCacheStats().entries).toBe(1);
  });

  test("semantic enforcement requires the exact active release capability", () => {
    const active = {
      status: "active" as const,
      claim: {
        environment: "production" as const,
        toolboxUserId: "user-1",
        agentId: "agent-1",
        releaseId: "release-1",
        releaseSequence: 1,
        snapshotDigest: "sha256:one",
        expiresAt: "2099-01-01T00:00:00.000Z",
        capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
      },
    };
    expect(
      resolveReleaseAwareToolRouterMode("semantic", active, "agent-1")
    ).toBe("semantic");
    expect(
      resolveReleaseAwareToolRouterMode("semantic", active, "agent-2")
    ).toBe("shadow");
    expect(
      resolveReleaseAwareToolRouterMode(
        "semantic",
        {
          ...active,
          claim: { ...active.claim, capabilityIds: [] },
        },
        "agent-1"
      )
    ).toBe("shadow");
    expect(
      resolveReleaseAwareToolRouterMode(
        "semantic",
        {
          status: "legacy_unenrolled",
        },
        "agent-1"
      )
    ).toBe("shadow");
    expect(
      resolveReleaseAwareToolRouterMode(
        "semantic",
        {
          ...active,
          claim: { ...active.claim, expiresAt: "2026-07-14T00:00:00.000Z" },
        },
        "agent-1",
        new Date("2026-07-15T00:00:00.000Z")
      )
    ).toBe("shadow");
    expect(resolveReleaseAwareToolRouterMode("shadow", active, "agent-1")).toBe(
      "shadow"
    );
  });
  test.each([
    ["undefined", undefined],
    ["Map", new Map([["type", "string"]])],
    ["Set", new Set(["string"])],
    ["Date", new Date("2026-07-14T00:00:00.000Z")],
    [
      "custom prototype",
      Object.assign(Object.create({ inherited: true }), { type: "object" }),
    ],
  ])("rejects non-JSON %s schema values without caching an empty-object collision", (_label, unsupported) => {
    clearToolInventorySnapshotCacheForTests();
    const valid = snapshotToolsByMcp({
      source: [{ name: "tool", inputSchema: {} }],
    });
    const before = toolInventorySnapshotCacheStats();

    expect(() =>
      snapshotToolsByMcp({
        source: [{ name: "tool", inputSchema: { unsupported } }],
      })
    ).toThrow("non-JSON tool inventory value");
    expect(toolInventorySnapshotCacheStats()).toEqual(before);
    expect(valid.source[0]?.inputSchema).toEqual({});
  });

  test.each([
    [
      "sparse array",
      (() => {
        const value = new Array(2);
        value[1] = "x";
        return value;
      })(),
    ],
    ["named array property", Object.assign(["x"], { extra: "y" })],
    [
      "non-index numeric array property",
      Object.assign(["x"], { "4294967295": "ghost" }),
    ],
    [
      "non-enumerable property",
      (() => {
        const value = { type: "object" };
        Object.defineProperty(value, "hidden", { value: "x" });
        return value;
      })(),
    ],
  ])("rejects JSON/clone mismatch from a %s", (_label, unsupported) => {
    expect(() =>
      snapshotToolsByMcp({
        source: [{ name: "bad", inputSchema: { unsupported } }],
      })
    ).toThrow("non-JSON tool inventory value");
  });

  test("rejects an overlarge array before traversing it", () => {
    const overlarge = new Array(100_001).fill("x");
    expect(() =>
      snapshotToolsByMcp({
        source: [{ name: "bad", inputSchema: { overlarge } }],
      })
    ).toThrow("array exceeds 100000 entries");
  });

  test("preserves a JSON own __proto__ key without mutating the clone prototype", () => {
    const inputSchema = JSON.parse(
      '{"type":"object","__proto__":{"polluted":true}}'
    ) as Record<string, unknown>;
    const snapshot = snapshotToolsByMcp({
      source: [{ name: "safe", inputSchema }],
    });
    const cloned = snapshot.source[0]!.inputSchema!;

    expect(Object.hasOwn(cloned, "__proto__")).toBe(true);
    expect((cloned.__proto__ as { polluted?: boolean }).polluted).toBe(true);
    expect(
      (Object.getPrototypeOf(cloned) as { polluted?: boolean }).polluted
    ).toBeUndefined();
  });

  test("rejects cyclic schemas instead of cloning a cyclic cache entry", () => {
    clearToolInventorySnapshotCacheForTests();
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;

    expect(() =>
      snapshotToolsByMcp({
        source: [{ name: "cyclic", inputSchema: cyclic }],
      })
    ).toThrow("cyclic tool inventory value");
    expect(toolInventorySnapshotCacheStats().entries).toBe(0);
  });

  test.each([
    ["MCP id key", () => ({ [UNPAIRED_HIGH]: [tool("safe", "safe")] })],
    ["tool name value", () => ({ source: [tool(UNPAIRED_LOW, "safe")] })],
    [
      "nested string value",
      () => ({
        source: [
          {
            name: "safe",
            inputSchema: { nested: { description: UNPAIRED_HIGH } },
          },
        ],
      }),
    ],
    [
      "nested property key",
      () => ({
        source: [
          {
            name: "safe",
            inputSchema: { nested: { [UNPAIRED_LOW]: true } },
          },
        ],
      }),
    ],
  ])("rejects an unpaired surrogate in a production inventory %s", (_label, inventory) => {
    expect(() => snapshotToolsByMcp(inventory())).toThrow(
      "invalid UTF-16 string: unpaired surrogate"
    );
  });

  test("preserves valid astral pairs in inventory keys and nested values", () => {
    const snapshot = snapshotToolsByMcp({
      "mcp-🧭": [
        {
          name: "提醒-💧",
          inputSchema: {
            type: "object",
            properties: { "欄位-🌟": { description: "內容-🚀" } },
          },
        },
      ],
    });

    expect(snapshot["mcp-🧭"]?.[0]?.name).toBe("提醒-💧");
    expect(
      snapshot["mcp-🧭"]?.[0]?.inputSchema?.properties?.["欄位-🌟"]
    ).toEqual({ description: "內容-🚀" });
  });

  test("validates an already frozen inventory before the immutable fast path", () => {
    clearToolInventorySnapshotCacheForTests();
    const frozenMap = Object.freeze(new Map([["type", "object"]]));
    const source = Object.freeze({
      source: Object.freeze([
        Object.freeze({ name: "bad", inputSchema: frozenMap }),
      ]),
    }) as unknown as Record<string, McpToolDef[]>;

    expect(() => snapshotToolsByMcp(source)).toThrow(
      "non-JSON tool inventory value"
    );
    expect(toolInventorySnapshotCacheStats().immutableReuses).toBe(0);
  });

  test("preserves caller identity for an already deeply immutable inventory", () => {
    clearToolInventorySnapshotCacheForTests();
    const immutableTool = Object.freeze({
      ...tool("search_students", "Find students"),
      inputSchema: Object.freeze({
        type: "object",
        properties: Object.freeze({
          query: Object.freeze({
            type: "string",
            description: "Original query",
          }),
        }),
      }),
    });
    const source = Object.freeze({
      school: Object.freeze([immutableTool]) as unknown as McpToolDef[],
    });

    expect(snapshotToolsByMcp(source)).toBe(source);
    expect(toolInventorySnapshotCacheStats().immutableReuses).toBe(1);
  });

  test("reuses the same snapshot across equal logical inventories", () => {
    clearToolInventorySnapshotCacheForTests();
    const source = { school: [tool("search_students", "Find students")] };
    const first = snapshotToolsByMcp(source);
    const second = snapshotToolsByMcp({
      school: [structuredClone(source.school[0])],
    });

    expect(second).toBe(first);
    expect(toolInventorySnapshotCacheStats()).toMatchObject({
      entries: 1,
      hits: 1,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.school)).toBe(true);
    expect(Object.isFrozen(first.school[0]?.inputSchema)).toBe(true);
  });

  test("reuses production initialization caches while applying authorization per turn", () => {
    clearToolInventorySnapshotCacheForTests();
    clearToolRetrievalIndexCacheForTests();
    const source = {
      school: [tool("search_students", "Find records by email")],
      drive: [tool("search_files", "Find records by email")],
    };
    const initialize = (
      toolsByMcp: Record<string, McpToolDef[]>,
      allowedToolNames: string[]
    ) =>
      initializeExternalTurnToolRouting(
        {
          toolsByMcp,
          message: "用 email 查資料",
          budget: 2,
          allowedToolNames,
          routerMode: "semantic",
          trace: {
            traceId: "tr_inventory_cache_test",
            journeyId: "line_text_agent_turn",
            actor: "worker",
            traceSource: "incoming",
          },
        },
        { emitEvent: () => undefined }
      );

    const first = initialize(source, ["school/search_students"]);
    const equalFreshInventory = structuredClone(source);
    const second = initialize(equalFreshInventory, ["drive/search_files"]);
    (
      equalFreshInventory.drive[0]?.inputSchema?.properties as Record<
        string,
        { description: string }
      >
    ).query.description = "Changed schema description";
    const changed = initialize(equalFreshInventory, ["drive/search_files"]);

    expect(first.selection.trace.cacheHit).toBe(false);
    expect(second.selection.trace.cacheHit).toBe(true);
    expect(second.selection.trace.selectedToolNames).toEqual([
      "drive/search_files",
    ]);
    expect(
      second.selection.trace.candidates.map(({ key }) => key)
    ).not.toContain("school/search_students");
    expect(changed.selection.trace.cacheHit).toBe(false);
    expect(changed.selection.trace.inventoryFingerprint).not.toBe(
      second.selection.trace.inventoryFingerprint
    );
    expect(first.selection.selectedTools.school[0]?.description).toBe(
      "Find records by email"
    );
    expect(toolInventorySnapshotCacheStats().hits).toBeGreaterThan(0);
  });

  test("invalidates name, schema, MCP order, and tool order changes", () => {
    clearToolInventorySnapshotCacheForTests();
    const alpha = tool("alpha_search", "Find alpha");
    const beta = tool("beta_search", "Find beta");
    const source = { first: [alpha, beta], second: [] as McpToolDef[] };
    const initial = snapshotToolsByMcp(source);

    alpha.name = "alpha_search_changed";
    const renamed = snapshotToolsByMcp(source);
    (
      alpha.inputSchema?.properties as Record<string, { description: string }>
    ).query.description = "Changed query";
    const schemaChanged = snapshotToolsByMcp(source);
    const toolReordered = snapshotToolsByMcp({
      first: [beta, alpha],
      second: [],
    });
    const mcpReordered = snapshotToolsByMcp({
      second: [],
      first: [beta, alpha],
    });

    expect(renamed).not.toBe(initial);
    expect(schemaChanged).not.toBe(renamed);
    expect(toolReordered).not.toBe(schemaChanged);
    expect(mcpReordered).not.toBe(toolReordered);
    expect(initial.first[0]?.name).toBe("alpha_search");
    expect(
      (
        initial.first[0]?.inputSchema?.properties as Record<
          string,
          { description: string }
        >
      ).query.description
    ).toBe("Original query");
  });

  test("bounds immutable inventory snapshots to the worker cache budget", () => {
    clearToolRouterRetainedMemoryForTests();
    clearToolInventorySnapshotCacheForTests();
    clearToolRetrievalIndexCacheForTests();
    for (let version = 0; version < 12; version++) {
      const snapshot = snapshotToolsByMcp({
        synthetic: Array.from({ length: 100 }, (_, index) =>
          tool(
            `tool_${version}_${index}`,
            `${version}-${index}-${"x".repeat(10_000)}`
          )
        ),
      });
      initializeExternalTurnToolRouting(
        {
          toolsByMcp: snapshot,
          message: "search synthetic",
          budget: 5,
          routerMode: "semantic",
          trace: {
            traceId: `mixed-${version}`,
            journeyId: "test",
            actor: "worker",
            traceSource: "incoming",
          },
        },
        { emitEvent: () => undefined }
      );
    }
    const stats = toolInventorySnapshotCacheStats();
    const combined = toolRouterRetainedMemoryStats();

    expect(combined.estimatedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(combined.maxEntryBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(combined.evictions).toBeGreaterThan(0);
  });

  test("reports mixed-cache evictions on the route that caused them", () => {
    clearToolRouterRetainedMemoryForTests();
    clearToolInventorySnapshotCacheForTests();
    clearToolRetrievalIndexCacheForTests();
    for (let version = 0; version < 2; version++) {
      snapshotToolsByMcp({
        bulk: Array.from({ length: 350 }, (_, index) =>
          tool(
            `snapshot_${version}_${index}`,
            `${"s".repeat(10_000)}-${version}-${index}`
          )
        ),
      });
    }
    const before = toolRouterRetainedMemoryStats();
    const route = initializeExternalTurnToolRouting(
      {
        toolsByMcp: {
          search: Array.from({ length: 400 }, (_, index) =>
            tool(
              `search_${index}`,
              `shared query ${"q".repeat(4_000)} ${index}`
            )
          ),
        },
        message: "shared query",
        budget: 5,
        routerMode: "semantic",
        trace: {
          traceId: "mixed-eviction",
          journeyId: "test",
          actor: "worker",
          traceSource: "incoming",
        },
      },
      { emitEvent: () => undefined }
    );
    const after = toolRouterRetainedMemoryStats();
    expect(after.evictions - before.evictions).toBeGreaterThan(0);
    expect(route.selection.trace.cacheEvictionCount).toBe(
      after.evictions - before.evictions
    );
  });
});
