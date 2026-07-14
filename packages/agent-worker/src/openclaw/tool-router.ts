import type { ToolCatalogEntry } from "./tool-catalog";
import { buildToolDescriptor } from "./tool-descriptor";
import {
	buildToolRetrievalIndex,
	searchToolRetrievalIndex,
	type ToolCandidateMatch,
} from "./tool-retrieval-index";
import { buildToolRouteQuery, type ToolDestination } from "./tool-route-query";

export interface ToolCandidateScore {
	key: string;
	totalScore: number;
	reasons: string[];
	scoreBreakdown?: ToolCandidateMatch["scoreBreakdown"];
}

export interface ToolRouteDecision {
	routerVersion: "semantic-v1";
	selectedEntries: ToolCatalogEntry[];
	candidates: ToolCandidateScore[];
	explicitDestinations: ToolDestination[];
	clarification?: {
		reason: "conflicting_destination" | "conflicting_side_effect";
		question: string;
		blockedToolKeys: string[];
	};
	fallback: null | "linear_scan" | "router_error" | "empty_query";
}

export interface RouteToolEntriesParams {
	entries: ToolCatalogEntry[];
	message: string;
	budget: number;
	reservedEntries: ToolCatalogEntry[];
}

function canonicalToolKey(entry: ToolCatalogEntry): string {
	return `${entry.mcpId}\u0000${entry.name}`;
}

function candidateScore(match: ToolCandidateMatch): ToolCandidateScore {
	const reasons = Object.entries(match.scoreBreakdown)
		.filter(([, score]) => score > 0)
		.map(([field]) => field);
	return {
		key: match.descriptor.key,
		totalScore: match.totalScore,
		reasons,
		scoreBreakdown: match.scoreBreakdown,
	};
}

export function routeToolEntries({
	entries,
	message,
	budget,
	reservedEntries,
}: RouteToolEntriesParams): ToolRouteDecision {
	const query = buildToolRouteQuery(message);
	const descriptors = entries.map((entry) =>
		buildToolDescriptor(entry.tool, entry.mcpId, entry.originalIndex),
	);
	const index = buildToolRetrievalIndex(descriptors);
	const matches = searchToolRetrievalIndex(index, message, entries.length);
	const entriesByCanonicalKey = new Map(
		entries.map((entry) => [canonicalToolKey(entry), entry] as const),
	);
	const scoredEntries = matches.flatMap((match) => {
		const entry = entriesByCanonicalKey.get(
			`${match.descriptor.mcpId}\u0000${match.descriptor.name}`,
		);
		return entry ? [{ entry, score: candidateScore(match) }] : [];
	});
	const selectedEntries: ToolCatalogEntry[] = [];
	const selectedKeys = new Set<string>();

	for (const entry of [
		...reservedEntries,
		...scoredEntries.map(({ entry }) => entry),
	]) {
		if (selectedEntries.length >= budget) break;
		const key = canonicalToolKey(entry);
		if (selectedKeys.has(key)) continue;
		selectedKeys.add(key);
		selectedEntries.push(entry);
	}

	return {
		routerVersion: "semantic-v1",
		selectedEntries,
		candidates: scoredEntries.map(({ score }) => score),
		explicitDestinations: query.explicitDestinations,
		fallback: index.mode === "linear" ? "linear_scan" : null,
	};
}
