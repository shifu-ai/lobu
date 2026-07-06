import type { AgentConfigStore, AgentMetadata, AgentSettings } from "@lobu/core";
import {
	canonicalMcpIdForConnector,
	connectorKeyAliases,
	type ToolboxMcpStatusConnectorKey,
} from "./connector-mcp-resolver.js";
import { createPostgresAgentConfigStore } from "./stores/postgres-stores.js";

export type LobuConnectorKey = ToolboxMcpStatusConnectorKey | (string & {});
export type LobuOAuthStatus = "authorized" | "needs_reauth" | "not_connected" | "unknown";
export type LobuAgentToolStatus = "usable" | "not_usable" | "unknown";

export interface LobuConnectorCurrentStatus {
	key: LobuConnectorKey;
	oauthStatus: LobuOAuthStatus;
	agentToolStatus: LobuAgentToolStatus;
	configured: boolean;
	authorized: boolean;
	toolNames?: string[];
}

export interface LobuConfigCurrentStatus {
	ok: true;
	agentId: string;
	userId: string;
	checkedAt: number;
	connectors: LobuConnectorCurrentStatus[];
}

export interface LobuConfigStatusService {
	getCurrentStatus(input: { agentId: string; userId: string }): Promise<LobuConfigCurrentStatus>;
}

export type LobuConfigStatusStore = Pick<AgentConfigStore, "getMetadata" | "getSettings">;

export class LobuConfigStatusError extends Error {
	constructor(
		readonly code: "agent_not_found" | "agent_owner_mismatch",
		message = code,
	) {
		super(message);
		this.name = "LobuConfigStatusError";
	}
}

const KNOWN_CONNECTORS: ToolboxMcpStatusConnectorKey[] = [
	"notion",
	"google_workspace",
	"shifu_toolbox",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function agentBelongsToToolboxUser(metadata: AgentMetadata, userId: string): boolean {
	return metadata.owner?.platform === "toolbox" && metadata.owner.userId === userId;
}

function configuredMcpIds(settings: AgentSettings | null): Set<string> {
	if (!settings || !isRecord(settings.mcpServers)) return new Set();
	return new Set(
		Object.entries(settings.mcpServers)
			.filter(([, config]) => isRecord(config))
			.map(([mcpId]) => mcpId),
	);
}

function hasKnownConnector(ids: Set<string>, key: ToolboxMcpStatusConnectorKey): boolean {
	const aliases = connectorKeyAliases(key);
	const canonical = canonicalMcpIdForConnector(key);
	if (ids.has(canonical)) return true;
	for (const id of ids) {
		if (aliases.has(id)) return true;
	}
	return false;
}

function statusFor(key: LobuConnectorKey, configured: boolean): LobuConnectorCurrentStatus {
	return {
		key,
		oauthStatus: "unknown",
		agentToolStatus: configured ? "usable" : "not_usable",
		configured,
		authorized: false,
	};
}

export function createLobuConfigStatusService(
	store: LobuConfigStatusStore = createPostgresAgentConfigStore(),
): LobuConfigStatusService {
	return {
		async getCurrentStatus({ agentId, userId }) {
			const metadata = await store.getMetadata(agentId);
			if (!metadata) {
				throw new LobuConfigStatusError("agent_not_found");
			}
			if (!agentBelongsToToolboxUser(metadata, userId)) {
				throw new LobuConfigStatusError("agent_owner_mismatch");
			}

			const ids = configuredMcpIds(await store.getSettings(agentId));
			const connectors = KNOWN_CONNECTORS.map((key) => statusFor(key, hasKnownConnector(ids, key)));
			const knownIds = new Set<string>();
			for (const key of KNOWN_CONNECTORS) {
				knownIds.add(canonicalMcpIdForConnector(key));
				for (const alias of connectorKeyAliases(key)) knownIds.add(alias);
			}
			for (const id of Array.from(ids).sort()) {
				if (!knownIds.has(id)) {
					connectors.push(statusFor(id, true));
				}
			}

			return {
				ok: true,
				agentId,
				userId,
				checkedAt: Date.now(),
				connectors,
			};
		},
	};
}
