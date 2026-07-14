import { describe, expect, test } from "bun:test";
import type { McpToolDef } from "@lobu/core";
import { buildToolDescriptor } from "../openclaw/tool-descriptor";
import {
	clearToolRetrievalIndexCacheForTests,
	getOrBuildToolRetrievalIndex,
	searchToolRetrievalIndex,
} from "../openclaw/tool-retrieval-index";

function syntheticTool(index: number): McpToolDef {
	return {
		name: `synthetic_tool_${index}`,
		description: `Search synthetic course record ${index}`,
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: `record ${index} query` },
			},
		},
	};
}

function percentile(values: number[], ratio: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
	);
}

describe("semantic tool router repeatable performance guard", () => {
	for (const size of [100, 500, 1_000, 2_000]) {
		test(`keeps reminder retrieval correct at ${size} tools; product SLO remains 10ms@500 and 25ms@2000`, () => {
			clearToolRetrievalIndexCacheForTests();
			const descriptors = Array.from({ length: size }, (_, index) =>
				buildToolDescriptor(syntheticTool(index), "synthetic", index),
			);
			descriptors[size - 1] = buildToolDescriptor(
				{
					name: "manage_schedules",
					description: "Create and manage delayed personal reminders",
					inputSchema: { type: "object", properties: {} },
				},
				"lobu-memory",
				size - 1,
			);

			getOrBuildToolRetrievalIndex(descriptors);
			const warmed = getOrBuildToolRetrievalIndex(descriptors);
			expect(warmed.cacheHit).toBe(true);
			const latencies: number[] = [];
			let matches = searchToolRetrievalIndex(
				warmed.index,
				"五分鐘後提醒我喝水",
				5,
			);
			for (let iteration = 0; iteration < 50; iteration++) {
				const startedAt = performance.now();
				matches = searchToolRetrievalIndex(
					warmed.index,
					"五分鐘後提醒我喝水",
					5,
				);
				latencies.push(performance.now() - startedAt);
			}

			const p50Ms = percentile(latencies, 0.5);
			const p95Ms = percentile(latencies, 0.95);
			console.info(
				`semantic-router benchmark size=${size} p50=${p50Ms.toFixed(3)}ms p95=${p95Ms.toFixed(3)}ms estimatedBytes=${warmed.index.estimatedBytes}`,
			);
			expect(matches[0]?.descriptor.key).toBe("lobu-memory/manage_schedules");
			// CI ceilings are regression guards, not a production SLO claim.
			expect(p95Ms).toBeLessThan(size <= 500 ? 30 : 75);
		});
	}
});
