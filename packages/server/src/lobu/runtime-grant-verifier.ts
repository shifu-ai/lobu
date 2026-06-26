import type { Grant } from "@lobu/core";
import {
	GLOBAL_TOOL_AUTO_APPROVAL_PATTERN,
	type GrantStore,
} from "../gateway/permissions/grant-store.js";

export type RuntimeGrantCheck = {
	pattern: string;
	kind: "mcp_tool";
	present: boolean;
	matchedPattern: string | null;
};

export type RuntimeGrantVerificationOk = {
	ok: true;
	sidecarRevisionRef: string;
	verifiedAt: string;
	runtime: {
		agentId: string;
		grantChecks: RuntimeGrantCheck[];
	};
};

export type RuntimeGrantVerificationFailure = {
	ok: false;
	errorCode: "runtime_grants_missing" | "invalid_expected_grant_patterns";
	userVisibleSummary: string;
	missingGrantPatterns?: string[];
};

export type RuntimeGrantVerificationResult =
	| RuntimeGrantVerificationOk
	| RuntimeGrantVerificationFailure;

export function validateExpectedGrantPatterns(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("expectedGrantPatterns must be an array");
	}
	const patterns = value.map((item) =>
		typeof item === "string" ? item.trim() : "",
	);
	if (
		patterns.length === 0 ||
		patterns.some(
			(pattern) =>
				pattern.length === 0 ||
				!pattern.startsWith("/mcp/") ||
				!pattern.includes("/tools/"),
		)
	) {
		throw new Error(
			"expectedGrantPatterns must contain MCP tool grant patterns",
		);
	}
	return patterns;
}

function wildcardCandidate(pattern: string): string | null {
	const lastSlash = pattern.lastIndexOf("/");
	if (lastSlash <= 0) return null;
	return `${pattern.substring(0, lastSlash)}/*`;
}

function isSpecificMcpToolPattern(pattern: string): boolean {
	const parts = pattern.split("/");
	return (
		parts.length === 5 &&
		parts[0] === "" &&
		parts[1] === "mcp" &&
		parts[2] !== "" &&
		parts[3] === "tools" &&
		parts[4] !== "" &&
		parts[2] !== "*" &&
		parts[4] !== "*"
	);
}

function grantCandidates(pattern: string): string[] {
	const candidates = [pattern];
	const wildcard = wildcardCandidate(pattern);
	if (wildcard) candidates.push(wildcard);
	if (isSpecificMcpToolPattern(pattern)) {
		candidates.push(GLOBAL_TOOL_AUTO_APPROVAL_PATTERN);
	}
	return candidates;
}

function findMatchedPattern(pattern: string, grants: Grant[]): string | null {
	for (const candidate of grantCandidates(pattern)) {
		const match = grants.find(
			(grant) =>
				grant.kind === "mcp_tool" &&
				!grant.denied &&
				grant.pattern === candidate,
		);
		if (match) return match.pattern;
	}
	return null;
}

export async function verifyRuntimeGrantPatterns(params: {
	grantStore: GrantStore;
	agentId: string;
	organizationId: string;
	revisionId: string;
	expectedGrantPatterns: string[];
}): Promise<RuntimeGrantVerificationResult> {
	const activeGrants = await params.grantStore.listGrants(
		params.agentId,
		params.organizationId,
	);
	const grantChecks: RuntimeGrantCheck[] = [];
	for (const pattern of params.expectedGrantPatterns) {
		const present = await params.grantStore.hasGrant(
			params.agentId,
			pattern,
			params.organizationId,
		);
		grantChecks.push({
			pattern,
			kind: "mcp_tool",
			present,
			matchedPattern: present
				? findMatchedPattern(pattern, activeGrants)
				: null,
		});
	}

	const missingGrantPatterns = grantChecks
		.filter((check) => !check.present)
		.map((check) => check.pattern);

	if (missingGrantPatterns.length > 0) {
		return {
			ok: false,
			errorCode: "runtime_grants_missing",
			userVisibleSummary:
				"Lobu runtime has not applied the expected MCP tool grants yet.",
			missingGrantPatterns,
		};
	}

	return {
		ok: true,
		sidecarRevisionRef: `lobu:${params.agentId}:${params.revisionId}`,
		verifiedAt: new Date().toISOString(),
		runtime: {
			agentId: params.agentId,
			grantChecks,
		},
	};
}
