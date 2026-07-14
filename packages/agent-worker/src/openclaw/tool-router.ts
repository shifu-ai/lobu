import type { ToolCatalogEntry } from "./tool-catalog";
import { buildToolRouteQuery, type ToolDestination } from "./tool-route-query";

export interface ToolCandidateScore {
  key: string;
  totalScore: number;
  reasons: string[];
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

function displayToolKey(entry: ToolCatalogEntry): string {
  return entry.mcpId ? `${entry.mcpId}/${entry.name}` : entry.name;
}

function scoreEntry(
  entry: ToolCatalogEntry,
  explicitDestinations: ToolDestination[]
): ToolCandidateScore {
  const reasons: string[] = [];
  let totalScore = 0;

  if (
    explicitDestinations.includes("personal_reminder") &&
    entry.mcpId === "lobu-memory" &&
    entry.name === "manage_schedules"
  ) {
    totalScore += 100;
    reasons.push("destination:personal_reminder");
  }
  if (
    explicitDestinations.includes("google_calendar") &&
    entry.mcpId === "google_workspace" &&
    entry.name === "gws_calendar_events_create"
  ) {
    totalScore += 100;
    reasons.push("destination:google_calendar");
  }

  return { key: displayToolKey(entry), totalScore, reasons };
}

export function routeToolEntries({
  entries,
  message,
  budget,
  reservedEntries,
}: RouteToolEntriesParams): ToolRouteDecision {
  const query = buildToolRouteQuery(message);
  const scoredEntries = entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, query.explicitDestinations),
    }))
    .sort(
      (left, right) =>
        right.score.totalScore - left.score.totalScore ||
        left.entry.originalIndex - right.entry.originalIndex
    );
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
    fallback: "linear_scan",
  };
}
