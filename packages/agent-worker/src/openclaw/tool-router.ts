import type { ToolCatalogEntry } from "./tool-catalog";
import { buildToolDescriptor, toolIdentityKey } from "./tool-descriptor";
import {
	buildToolRetrievalIndex,
	searchToolRetrievalIndex,
	type ToolCandidateMatch,
} from "./tool-retrieval-index";
import {
	buildToolRouteQuery,
	type ToolDestination,
	type ToolOperation,
} from "./tool-route-query";

const AMBIGUITY_SCORE_RATIO = 1.25;
const CLARIFICATION_QUESTION =
	"你要我建立 Google Calendar 行事曆事件，還是只在時間到時提醒你？";

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
		blockedToolNames: string[];
	};
	fallback: null | "linear_scan" | "router_error" | "empty_query";
}

export interface RouteToolEntriesParams {
	entries: ToolCatalogEntry[];
	message: string;
	budget: number;
	reservedEntries: ToolCatalogEntry[];
	allowedToolNames?: Iterable<string>;
}

function canonicalToolKey(entry: ToolCatalogEntry): string {
	return toolIdentityKey(entry.mcpId, entry.name);
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

function normalizeAllowedName(name: string): string {
	return name.trim().toLowerCase();
}

function eligibleIdentityKeys(
	entries: ToolCatalogEntry[],
	allowedToolNames: Iterable<string> | undefined,
): Set<string> | undefined {
	if (allowedToolNames === undefined) return undefined;
	const allowed = new Set(
		[...allowedToolNames].map(normalizeAllowedName).filter(Boolean),
	);
	return new Set(
		entries
			.filter((entry) => {
				const plainName = normalizeAllowedName(entry.name);
				const qualifiedName = normalizeAllowedName(
					entry.mcpId ? `${entry.mcpId}/${entry.name}` : entry.name,
				);
				return allowed.has(plainName) || allowed.has(qualifiedName);
			})
			.map(canonicalToolKey),
	);
}

function retrievalQuery(
	message: string,
	operations: readonly string[],
	explicitDestinations: readonly ToolDestination[],
): string {
	if (
		explicitDestinations.length === 0 &&
		operations.includes("schedule") &&
		operations.includes("create")
	) {
		return `${message} calendar event meeting`;
	}
	return message;
}

function conflictsWithExplicitDestination(
	match: ToolCandidateMatch,
	explicitDestinations: readonly ToolDestination[],
): boolean {
	if (!match.descriptor.mutatesState || explicitDestinations.length === 0) {
		return false;
	}
	return (
		match.descriptor.destinations.length > 0 &&
		!match.descriptor.destinations.some((destination) =>
			explicitDestinations.includes(destination),
		)
	);
}

function isRelevantMutatingMatch(
	match: ToolCandidateMatch,
	operations: readonly ToolOperation[],
	explicitDestinations: readonly ToolDestination[],
): boolean {
	if (!match.descriptor.mutatesState || match.totalScore <= 0) return false;
	if (explicitDestinations.length > 0) {
		return match.descriptor.destinations.some((destination) =>
			explicitDestinations.includes(destination),
		);
	}
	const meaningfulOperations = operations.filter(
		(operation) => operation !== "unknown",
	);
	if (meaningfulOperations.length === 0) return true;
	return meaningfulOperations.some((operation) =>
		match.descriptor.operations.includes(operation),
	);
}

function ambiguousWriteMatches(
	matches: ToolCandidateMatch[],
	operations: readonly ToolOperation[],
	explicitDestinations: readonly ToolDestination[],
): ToolCandidateMatch[] {
	if (explicitDestinations.length > 0) return [];
	const relevant = matches.filter((match) =>
		isRelevantMutatingMatch(match, operations, explicitDestinations),
	);
	const [first, second] = relevant;
	if (!first || !second || second.totalScore <= 0) return [];
	if (
		first.descriptor.destinations.length === 0 ||
		second.descriptor.destinations.length === 0 ||
		first.descriptor.destinations.some((destination) =>
			second.descriptor.destinations.includes(destination),
		)
	) {
		return [];
	}
	if (first.totalScore / second.totalScore > AMBIGUITY_SCORE_RATIO) return [];
	return [first, second];
}

export function routeToolEntries({
	entries,
	message,
	budget,
	reservedEntries,
	allowedToolNames,
}: RouteToolEntriesParams): ToolRouteDecision {
	const query = buildToolRouteQuery(message);
	const descriptors = entries.map((entry) =>
		buildToolDescriptor(entry.tool, entry.mcpId, entry.originalIndex),
	);
	const index = buildToolRetrievalIndex(descriptors);
	const eligibleKeys = eligibleIdentityKeys(entries, allowedToolNames);
	const matches = searchToolRetrievalIndex(
		index,
		retrievalQuery(message, query.operations, query.explicitDestinations),
		entries.length,
		eligibleKeys,
	).filter(
		(match) =>
			!conflictsWithExplicitDestination(match, query.explicitDestinations),
	);
	const entriesByIdentityKey = new Map(
		descriptors.flatMap((descriptor, index) => {
			const entry = entries[index];
			return entry ? [[descriptor.identityKey, entry] as const] : [];
		}),
	);
	const scoredEntries = matches.flatMap((match) => {
		const entry = entriesByIdentityKey.get(match.descriptor.identityKey);
		return entry ? [{ entry, score: candidateScore(match) }] : [];
	});
	const blockedMatches = ambiguousWriteMatches(
		matches,
		query.operations,
		query.explicitDestinations,
	);
	const blockedKeys = new Set(
		blockedMatches.map((match) => match.descriptor.identityKey),
	);
	const eligibleEntries = entries.filter(
		(entry) => !eligibleKeys || eligibleKeys.has(canonicalToolKey(entry)),
	);
	const selectedEntries: ToolCatalogEntry[] = [];
	const selectedKeys = new Set<string>();

	for (const entry of [
		...reservedEntries.filter(
			(entry) =>
				(!eligibleKeys || eligibleKeys.has(canonicalToolKey(entry))) &&
				!blockedKeys.has(canonicalToolKey(entry)),
		),
		...scoredEntries
			.filter(({ entry, score }) => {
				if (blockedKeys.has(canonicalToolKey(entry)) || score.totalScore <= 0) {
					return false;
				}
				const match = matches.find(
					(candidate) =>
						candidate.descriptor.identityKey === canonicalToolKey(entry),
				);
				return (
					!entry.mutatesState ||
					(match !== undefined &&
						isRelevantMutatingMatch(
							match,
							query.operations,
							query.explicitDestinations,
						))
				);
			})
			.map(({ entry }) => entry),
		...eligibleEntries.filter(
			(entry) => entry.readOnly && !blockedKeys.has(canonicalToolKey(entry)),
		),
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
		clarification:
			blockedMatches.length > 0
				? {
						reason: "conflicting_destination",
						question: CLARIFICATION_QUESTION,
						blockedToolKeys: blockedMatches.map(
							(match) => match.descriptor.identityKey,
						),
						blockedToolNames: blockedMatches
							.map((match) => match.descriptor.key)
							.sort(),
					}
				: undefined,
		fallback: index.mode === "linear" ? "linear_scan" : null,
	};
}
