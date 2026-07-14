import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";
import { initializeExternalTurnToolRouting } from "../openclaw/session-runner";
import { catalogEntryForTool } from "../openclaw/tool-catalog";
import { buildToolDescriptor } from "../openclaw/tool-descriptor";
import {
  clearToolInventorySnapshotCacheForTests,
  toolInventorySnapshotCacheStats,
} from "../openclaw/tool-inventory-snapshot";
import {
  clearToolRetrievalIndexCacheForTests,
  getOrBuildToolRetrievalIndex,
  searchToolRetrievalIndex,
  toolRetrievalIndexCacheStats,
} from "../openclaw/tool-retrieval-index";
import { parseWorkerShifuTrace } from "../shared/journey-trace";
import { routeToolEntries } from "../openclaw/tool-router";
import { toolRouterRetainedMemoryStats } from "../openclaw/tool-router-memory-budget";

function syntheticTool(index: number): McpToolDef {
  return Object.freeze({
    name: `synthetic_tool_${index}`,
    description: `Search synthetic course record ${index}`,
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({
          type: "string",
          description: `record ${index} query`,
        }),
      }),
    }),
  });
}

function immutableReminderTool(): McpToolDef {
  return Object.freeze({
    name: "manage_schedules",
    description: "Create and manage delayed personal reminders",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({}),
    }),
  });
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
  );
}

describe("semantic tool router repeatable performance guard", () => {
  test("high-confidence acknowledgements skip semantic retrieval while unknown prose still routes", () => {
    clearToolRetrievalIndexCacheForTests();
    const toolsByMcp = {
      synthetic: Array.from({ length: 2_000 }, (_, index) =>
        syntheticTool(index)
      ),
    };
    const before = toolRetrievalIndexCacheStats();
    let emitted: unknown;
    const ack = initializeExternalTurnToolRouting(
      {
        toolsByMcp,
        message: "收到，謝謝！",
        budget: 12,
        routerMode: "semantic",
        trace: parseWorkerShifuTrace({}),
      },
      {
        emitEvent: (event) => {
          emitted = event;
        },
      }
    );
    expect(ack.selection.trace.semanticComputed).toBe(false);
    expect(ack.selection.trace.semanticLookupSkippedReason).toBe(
      "definite_non_tool"
    );
    expect(JSON.stringify(emitted)).not.toContain("收到，謝謝");
    expect(toolRetrievalIndexCacheStats().misses).toBe(before.misses);

    initializeExternalTurnToolRouting(
      {
        toolsByMcp,
        message: "幫我處理一下這個",
        budget: 12,
        routerMode: "semantic",
        trace: parseWorkerShifuTrace({}),
      },
      { emitEvent: () => undefined }
    );
    expect(toolRetrievalIndexCacheStats().misses).toBeGreaterThan(
      before.misses
    );
  });
  for (const size of [100, 500, 1_000, 2_000]) {
    test(`external-turn lifecycle guard at ${size} tools; CI ceiling is not the product SLO`, () => {
      clearToolRetrievalIndexCacheForTests();
      clearToolInventorySnapshotCacheForTests();
      const toolsByMcp = {
        synthetic: Array.from({ length: size - 1 }, (_, index) =>
          syntheticTool(index)
        ),
        "lobu-memory": [immutableReminderTool()],
      };
      const allowedToolNames = [
        ...toolsByMcp.synthetic.map((tool) => `synthetic/${tool.name}`),
        "lobu-memory/manage_schedules",
      ];
      const initialize = () =>
        initializeExternalTurnToolRouting(
          {
            toolsByMcp,
            message: "五分鐘後提醒我喝水",
            budget: 48,
            allowedToolNames,
            routerMode: "semantic",
            trace: {
              traceId: "tr_benchmark",
              journeyId: "line_text_agent_turn",
              actor: "worker",
              traceSource: "incoming",
            },
          },
          { emitEvent: () => undefined }
        );
      initialize();
      const lifecycleLatencies: number[] = [];
      const selectionLatencies: number[] = [];
      let result = initialize();
      for (let iteration = 0; iteration < 50; iteration++) {
        const startedAt = performance.now();
        result = initialize();
        lifecycleLatencies.push(performance.now() - startedAt);
        selectionLatencies.push(result.routeTotalMs);
      }
      const lifecycleP95Ms = percentile(lifecycleLatencies, 0.95);
      const selectionP95Ms = percentile(selectionLatencies, 0.95);
      const productSloMs = size <= 500 ? 10 : 25;
      const combinedMemory = toolRouterRetainedMemoryStats();
      console.info(
        `semantic-router external-turn-lifecycle size=${size} lifecycleP50=${percentile(lifecycleLatencies, 0.5).toFixed(3)}ms lifecycleP95=${lifecycleP95Ms.toFixed(3)}ms selectionP95=${selectionP95Ms.toFixed(3)}ms productSlo=${productSloMs}ms productSloPass=${lifecycleP95Ms < productSloMs} ciCeiling=${size <= 500 ? 30 : 75}ms snapshotCacheHits=${toolInventorySnapshotCacheStats().hits} combinedRetainedBytes=${combinedMemory.estimatedBytes} combinedRetainedEntries=${combinedMemory.entries}`
      );
      expect(result.selection.trace.selectedToolNames).toContain(
        "lobu-memory/manage_schedules"
      );
      expect(toolInventorySnapshotCacheStats().hits).toBeGreaterThan(0);
      expect(combinedMemory.estimatedBytes).toBeLessThanOrEqual(
        32 * 1024 * 1024
      );
      expect(lifecycleP95Ms).toBeLessThan(size <= 500 ? 30 : 75);
    });

    test(`lower-level production route guard at ${size} tools`, () => {
      clearToolRetrievalIndexCacheForTests();
      const entries = Array.from({ length: size }, (_, index) =>
        catalogEntryForTool(syntheticTool(index), index, "synthetic")
      );
      entries[size - 1] = catalogEntryForTool(
        immutableReminderTool(),
        size - 1,
        "lobu-memory"
      );
      const allowedToolNames = entries.map(
        (entry) => `${entry.mcpId}/${entry.name}`
      );
      const route = () =>
        routeToolEntries({
          entries,
          message: "五分鐘後提醒我喝水",
          budget: 48,
          reservedEntries: [],
          allowedToolNames,
        });
      route();
      const latencies: number[] = [];
      let result = route();
      for (let iteration = 0; iteration < 50; iteration++) {
        const startedAt = performance.now();
        result = route();
        latencies.push(performance.now() - startedAt);
      }

      const p50Ms = percentile(latencies, 0.5);
      const p95Ms = percentile(latencies, 0.95);
      const productSloMs = size <= 500 ? 10 : 25;
      console.info(
        `semantic-router production-route size=${size} p50=${p50Ms.toFixed(3)}ms p95=${p95Ms.toFixed(3)}ms productSlo=${productSloMs}ms productSloPass=${p95Ms < productSloMs} ciCeiling=${size <= 500 ? 30 : 75}ms estimatedBytes=${result.estimatedIndexBytes}`
      );
      expect(result.selectedEntries[0]?.name).toBe("manage_schedules");
      expect(result.cacheHit).toBe(true);
      // CI ceilings are regression guards, not a production SLO claim.
      expect(p95Ms).toBeLessThan(size <= 500 ? 30 : 75);
    });
  }

  test("labels warm search-only latency as a microbenchmark", () => {
    const descriptors = Array.from({ length: 2_000 }, (_, index) =>
      buildToolDescriptor(syntheticTool(index), "synthetic", index)
    );
    descriptors[1_999] = buildToolDescriptor(
      immutableReminderTool(),
      "lobu-memory",
      1_999
    );
    const index = getOrBuildToolRetrievalIndex(descriptors).index;
    const latencies: number[] = [];
    let matches = searchToolRetrievalIndex(index, "五分鐘後提醒我喝水", 5);
    for (let iteration = 0; iteration < 50; iteration++) {
      const startedAt = performance.now();
      matches = searchToolRetrievalIndex(index, "五分鐘後提醒我喝水", 5);
      latencies.push(performance.now() - startedAt);
    }
    console.info(
      `semantic-router search-only-microbenchmark size=2000 p95=${percentile(latencies, 0.95).toFixed(3)}ms`
    );
    expect(matches[0]?.descriptor.key).toBe("lobu-memory/manage_schedules");
  });

  test("measures rollout-mode selection separately from the production route core", () => {
    const toolsByMcp = {
      aaa: Array.from({ length: 1_999 }, (_, index) => syntheticTool(index)),
      "lobu-memory": [immutableReminderTool()],
    };
    const allowedToolNames = [
      ...toolsByMcp.aaa.map((tool) => `aaa/${tool.name}`),
      "lobu-memory/manage_schedules",
    ];
    const measure = (routerMode: "shadow" | "semantic") => {
      const latencies: number[] = [];
      let result = selectMcpToolsByMcpForTurn({
        toolsByMcp,
        message: "五分鐘後提醒我喝水",
        budget: 48,
        allowedToolNames,
        routerMode,
      });
      for (let iteration = 0; iteration < 50; iteration++) {
        const startedAt = performance.now();
        result = selectMcpToolsByMcpForTurn({
          toolsByMcp,
          message: "五分鐘後提醒我喝水",
          budget: 48,
          allowedToolNames,
          routerMode,
        });
        latencies.push(performance.now() - startedAt);
      }
      return { result, p95Ms: percentile(latencies, 0.95) };
    };

    const shadow = measure("shadow");
    const semantic = measure("semantic");
    console.info(
      `semantic-router rollout-selector size=2000 shadowP95=${shadow.p95Ms.toFixed(3)}ms semanticP95=${semantic.p95Ms.toFixed(3)}ms ciCeiling=75ms`
    );
    expect(shadow.result.trace.routerMode).toBe("shadow");
    expect(shadow.result.trace.selectedToolNames).not.toContain(
      "lobu-memory/manage_schedules"
    );
    expect(semantic.result.trace.selectedToolNames).toContain(
      "lobu-memory/manage_schedules"
    );
    expect(shadow.p95Ms).toBeLessThan(75);
    expect(semantic.p95Ms).toBeLessThan(75);
  });
});
