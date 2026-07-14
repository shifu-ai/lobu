import type { ToolCatalogEntry } from "./tool-catalog";
import {
  getOrBuildToolDescriptor,
  qualifiedToolKey,
  toolIdentityKey,
} from "./tool-descriptor";
import {
  type CachedToolRetrievalIndex,
  getOrBuildToolRetrievalIndex,
  searchToolRetrievalIndex,
  type ToolCandidateMatch,
} from "./tool-retrieval-index";
import {
  buildToolRouteQuery,
  type ToolDestination,
  type ToolOperation,
} from "./tool-route-query";
import { normalizeToolText } from "./tool-tokenizer";

const AMBIGUITY_SCORE_RATIO = 1.25;
const DESTINATION_CLARIFICATION_QUESTION =
  "你要我建立 Google Calendar 行事曆事件，還是只在時間到時提醒你？";

export interface ToolCandidateScore {
  key: string;
  totalScore: number;
  reasons: string[];
  scoreBreakdown?: ToolCandidateMatch["scoreBreakdown"];
}

export interface ToolRouteDecision {
  routerVersion: "semantic-v1";
  inventoryFingerprint: string;
  cacheHit: boolean;
  estimatedIndexBytes: number;
  cacheEvictionCount: number;
  timingMs: {
    build: number;
    retrieve: number;
    rank: number;
  };
  selectedEntries: ToolCatalogEntry[];
  candidates: ToolCandidateScore[];
  explicitDestinations: ToolDestination[];
  semanticLookupSkippedReason?: "definite_non_tool";
  clarification?: {
    reason: "conflicting_destination" | "conflicting_side_effect";
    question: string;
    blockedToolKeys: string[];
    blockedToolIdentityKeys: string[];
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
  retrieval?: {
    getOrBuild?: (
      descriptors: ReturnType<typeof getOrBuildToolDescriptor>[]
    ) => CachedToolRetrievalIndex;
    search?: typeof searchToolRetrievalIndex;
  };
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
  allowedToolNames: Iterable<string> | undefined
): Set<string> | undefined {
  if (allowedToolNames === undefined) return undefined;
  const allowed = new Set(
    [...allowedToolNames].map(normalizeAllowedName).filter(Boolean)
  );
  const qualifiedNameCounts = new Map<string, number>();
  for (const entry of entries) {
    const qualifiedName = normalizeAllowedName(
      entry.mcpId ? qualifiedToolKey(entry.mcpId, entry.name) : entry.name
    );
    qualifiedNameCounts.set(
      qualifiedName,
      (qualifiedNameCounts.get(qualifiedName) ?? 0) + 1
    );
  }
  return new Set(
    entries
      .filter((entry) => {
        const plainName = normalizeAllowedName(entry.name);
        const qualifiedName = normalizeAllowedName(
          entry.mcpId ? qualifiedToolKey(entry.mcpId, entry.name) : entry.name
        );
        return (
          (!plainName.includes("/") && allowed.has(plainName)) ||
          (allowed.has(qualifiedName) &&
            qualifiedNameCounts.get(qualifiedName) === 1)
        );
      })
      .map(canonicalToolKey)
  );
}

export function filterEligibleToolEntries(
  entries: ToolCatalogEntry[],
  allowedToolNames: Iterable<string> | undefined
): ToolCatalogEntry[] {
  const eligibleKeys = eligibleIdentityKeys(entries, allowedToolNames);
  return entries.filter(
    (entry) => !eligibleKeys || eligibleKeys.has(canonicalToolKey(entry))
  );
}

function retrievalQuery(
  message: string,
  operations: readonly string[],
  explicitDestinations: readonly ToolDestination[]
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
  descriptor: ToolCandidateMatch["descriptor"],
  explicitDestinations: readonly ToolDestination[]
): boolean {
  if (!descriptor.mutatesState || explicitDestinations.length === 0) {
    return false;
  }
  return (
    descriptor.destinations.length > 0 &&
    !descriptor.destinations.some((destination) =>
      explicitDestinations.includes(destination)
    )
  );
}

function isRelevantMutatingMatch(
  match: ToolCandidateMatch,
  operations: readonly ToolOperation[],
  explicitDestinations: readonly ToolDestination[]
): boolean {
  if (!match.descriptor.mutatesState || match.totalScore <= 0) return false;
  if (explicitDestinations.length > 0) {
    return (
      match.descriptor.destinations.some((destination) =>
        explicitDestinations.includes(destination)
      ) && operationIsCompatible(match, operations)
    );
  }
  return operationIsCompatible(match, operations);
}

function operationIsCompatible(
  match: ToolCandidateMatch,
  operations: readonly ToolOperation[]
): boolean {
  const meaningfulOperations = operations.filter(
    (operation) => operation !== "unknown"
  );
  if (meaningfulOperations.length === 0) return true;
  return meaningfulOperations.some((operation) =>
    match.descriptor.operations.includes(operation)
  );
}

function ambiguousWriteMatches(
  matches: ToolCandidateMatch[],
  operations: readonly ToolOperation[],
  explicitDestinations: readonly ToolDestination[]
): ToolCandidateMatch[] {
  if (explicitDestinations.length > 0) return [];
  const relevant = matches.filter((match) =>
    isRelevantMutatingMatch(match, operations, explicitDestinations)
  );
  const [first, second] = relevant;
  if (!first || !second || second.totalScore <= 0) return [];
  if (!hasConflictingSideEffects(first, second)) return [];
  if (first.totalScore / second.totalScore > AMBIGUITY_SCORE_RATIO) return [];
  return relevant.filter(
    (match) =>
      match.totalScore > 0 &&
      first.totalScore / match.totalScore <= AMBIGUITY_SCORE_RATIO &&
      (match === first || hasConflictingSideEffects(first, match))
  );
}

function hasConflictingSideEffects(
  first: ToolCandidateMatch,
  second: ToolCandidateMatch
): boolean {
  const firstDestinations = first.descriptor.destinations;
  const secondDestinations = second.descriptor.destinations;
  if (
    firstDestinations.length > 0 &&
    secondDestinations.length > 0 &&
    !firstDestinations.some((value) => secondDestinations.includes(value))
  ) {
    return true;
  }
  const firstClasses = first.descriptor.sideEffectClasses;
  const secondClasses = second.descriptor.sideEffectClasses;
  const firstEffect = first.descriptor.primarySideEffect;
  const secondEffect = second.descriptor.primarySideEffect;
  if (firstEffect && secondEffect) {
    return (
      firstEffect.action !== secondEffect.action ||
      firstEffect.resource !== secondEffect.resource ||
      firstEffect.destination !== secondEffect.destination
    );
  }
  return (
    firstClasses.length > 0 &&
    secondClasses.length > 0 &&
    !firstClasses.some((value) => secondClasses.includes(value))
  );
}

function clarificationReason(
  matches: ToolCandidateMatch[]
): "conflicting_destination" | "conflicting_side_effect" {
  const [first, second] = matches;
  return first &&
    second &&
    first.descriptor.destinations.length > 0 &&
    second.descriptor.destinations.length > 0
    ? "conflicting_destination"
    : "conflicting_side_effect";
}

function clarificationQuestion(matches: ToolCandidateMatch[]): string {
  if (clarificationReason(matches) === "conflicting_destination") {
    return DESTINATION_CLARIFICATION_QUESTION;
  }
  const labels = matches.map((match) => {
    const stableIdentity = [
      ...`${match.descriptor.mcpId}/${match.descriptor.name}`.normalize("NFKC"),
    ]
      .map((character) => {
        const codepoint = character.codePointAt(0) ?? 0;
        return codepoint <= 0x1f || (codepoint >= 0x7f && codepoint <= 0x9f)
          ? " "
          : character;
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    return `「${stableIdentity || "unknown tool"}」`;
  });
  return `你要我使用 ${labels.join("，還是 ")}？這些工具會產生不同的寫入結果。`;
}

function safeReservedEntries(params: {
  entries: ToolCatalogEntry[];
  reservedEntries: ToolCatalogEntry[];
  allowedToolNames?: Iterable<string>;
  budget: number;
}): ToolCatalogEntry[] {
  // Built-in control/meta tools are registered outside the MCP router. When
  // semantic routing is unavailable, exposing no MCP tool is the only fallback
  // that cannot accidentally surface a pinned write misclassified by metadata.
  void params;
  return [];
}

function fallbackDecision(
  params: RouteToolEntriesParams,
  fallback: "router_error" | "empty_query",
  explicitDestinations: ToolDestination[] = []
): ToolRouteDecision {
  return {
    routerVersion: "semantic-v1",
    inventoryFingerprint: "",
    cacheHit: false,
    estimatedIndexBytes: 0,
    cacheEvictionCount: 0,
    timingMs: { build: 0, retrieve: 0, rank: 0 },
    selectedEntries: safeReservedEntries(params),
    candidates: [],
    explicitDestinations,
    fallback,
  };
}

export function routeToolEntries({
  entries,
  message,
  budget,
  reservedEntries,
  allowedToolNames,
  retrieval,
}: RouteToolEntriesParams): ToolRouteDecision {
  const query = buildToolRouteQuery(message);
  if (!normalizeToolText(message)) {
    return fallbackDecision(
      {
        entries,
        message,
        budget,
        reservedEntries,
        allowedToolNames,
        retrieval,
      },
      "empty_query",
      query.explicitDestinations
    );
  }
  try {
    const buildStartedAt = performance.now();
    const descriptors = entries.map((entry) =>
      getOrBuildToolDescriptor(entry.tool, entry.mcpId, entry.originalIndex)
    );
    const cachedIndex = (retrieval?.getOrBuild ?? getOrBuildToolRetrievalIndex)(
      descriptors
    );
    const index = cachedIndex.index;
    const eligibleKeys = eligibleIdentityKeys(entries, allowedToolNames);
    const buildMs = performance.now() - buildStartedAt;
    const retrieveStartedAt = performance.now();
    const matches = (retrieval?.search ?? searchToolRetrievalIndex)(
      index,
      retrievalQuery(message, query.operations, query.explicitDestinations),
      entries.length,
      eligibleKeys
    ).filter(
      (match) =>
        !conflictsWithExplicitDestination(
          match.descriptor,
          query.explicitDestinations
        )
    );
    const descriptorsByIdentityKey = new Map(
      descriptors.map(
        (descriptor) => [descriptor.identityKey, descriptor] as const
      )
    );
    const retrieveMs = performance.now() - retrieveStartedAt;
    const rankStartedAt = performance.now();
    const entriesByIdentityKey = new Map(
      descriptors.flatMap((descriptor, index) => {
        const entry = entries[index];
        return entry ? [[descriptor.identityKey, entry] as const] : [];
      })
    );
    const scoredEntries = matches.flatMap((match) => {
      const entry = entriesByIdentityKey.get(match.descriptor.identityKey);
      return entry ? [{ entry, score: candidateScore(match) }] : [];
    });
    const blockedMatches = ambiguousWriteMatches(
      matches,
      query.operations,
      query.explicitDestinations
    );
    const blockedKeys = new Set(
      blockedMatches.map((match) => match.descriptor.identityKey)
    );
    const relevantMutatingMatches = matches.filter((match) =>
      isRelevantMutatingMatch(
        match,
        query.operations,
        query.explicitDestinations
      )
    );
    const [topMutating, secondMutating] = relevantMutatingMatches;
    const dominatedConflictingKeys = new Set<string>();
    if (
      blockedMatches.length === 0 &&
      query.explicitDestinations.length === 0 &&
      topMutating &&
      secondMutating &&
      hasConflictingSideEffects(topMutating, secondMutating) &&
      topMutating.totalScore / secondMutating.totalScore > AMBIGUITY_SCORE_RATIO
    ) {
      for (const match of relevantMutatingMatches.slice(1)) {
        if (hasConflictingSideEffects(topMutating, match)) {
          dominatedConflictingKeys.add(match.descriptor.identityKey);
        }
      }
    }
    const selectedEntries: ToolCatalogEntry[] = [];
    const selectedKeys = new Set<string>();

    for (const entry of [
      ...reservedEntries.filter((entry) => {
        const identityKey = canonicalToolKey(entry);
        const descriptor = descriptorsByIdentityKey.get(identityKey);
        return (
          (!eligibleKeys || eligibleKeys.has(identityKey)) &&
          !blockedKeys.has(identityKey) &&
          !dominatedConflictingKeys.has(identityKey) &&
          descriptor !== undefined &&
          !conflictsWithExplicitDestination(
            descriptor,
            query.explicitDestinations
          )
        );
      }),
      ...scoredEntries
        .filter(({ entry, score }) => {
          if (
            blockedKeys.has(canonicalToolKey(entry)) ||
            dominatedConflictingKeys.has(canonicalToolKey(entry)) ||
            score.totalScore <= 0
          ) {
            return false;
          }
          const match = matches.find(
            (candidate) =>
              candidate.descriptor.identityKey === canonicalToolKey(entry)
          );
          return (
            match !== undefined &&
            (!match.descriptor.mutatesState ||
              isRelevantMutatingMatch(
                match,
                query.operations,
                query.explicitDestinations
              ))
          );
        })
        .map(({ entry }) => entry),
    ]) {
      if (selectedEntries.length >= budget) break;
      const key = canonicalToolKey(entry);
      if (selectedKeys.has(key)) continue;
      selectedKeys.add(key);
      selectedEntries.push(entry);
    }

    return {
      routerVersion: "semantic-v1",
      inventoryFingerprint: index.fingerprint,
      cacheHit: cachedIndex.cacheHit,
      estimatedIndexBytes: index.estimatedBytes,
      cacheEvictionCount: cachedIndex.cacheEvictionCount,
      timingMs: {
        build: buildMs,
        retrieve: retrieveMs,
        rank: performance.now() - rankStartedAt,
      },
      selectedEntries,
      candidates: scoredEntries.map(({ score }) => score),
      explicitDestinations: query.explicitDestinations,
      clarification:
        blockedMatches.length > 0
          ? {
              reason: clarificationReason(blockedMatches),
              question: clarificationQuestion(blockedMatches),
              blockedToolKeys: blockedMatches.map(
                (match) => match.descriptor.key
              ),
              blockedToolIdentityKeys: blockedMatches.map(
                (match) => match.descriptor.identityKey
              ),
              blockedToolNames: blockedMatches
                .map((match) => match.descriptor.key)
                .sort(),
            }
          : undefined,
      fallback: index.mode === "linear" ? "linear_scan" : null,
    };
  } catch {
    return fallbackDecision(
      {
        entries,
        message,
        budget,
        reservedEntries,
        allowedToolNames,
        retrieval,
      },
      "router_error",
      query.explicitDestinations
    );
  }
}
