import type { AgentConfigStore, AgentMetadata, AgentSettings } from "@lobu/core";
import { getStoredCredential } from "../gateway/routes/internal/device-auth.js";
import type { WritableSecretStore } from "../gateway/secrets/index.js";
import {
	canonicalMcpIdForConnector,
	connectorKeyAliases,
	type ToolboxMcpStatusConnectorKey,
} from "./connector-mcp-resolver.js";
import {
	isUiManagedMcp,
	statusReasonForConnector,
	type ShifuMcpStatusReasonCode,
} from "./provisioning-routes.js";
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
	reasonCode: ShifuMcpStatusReasonCode;
	reauthorizationAvailable: boolean;
	authorizationUrlAvailable: boolean;
	uiManaged: boolean;
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

export interface LobuOAuthStatusProvider {
	getOAuthStatus(input: {
		agentId: string;
		userId: string;
		connectorKey: LobuConnectorKey;
		mcpId: string;
	}): Promise<LobuOAuthStatus>;
}

interface LobuConfigStatusServiceOptions {
	store?: LobuConfigStatusStore;
	oauthStatusProvider?: LobuOAuthStatusProvider;
	secretStore?: WritableSecretStore;
	getSecretStore?: () => WritableSecretStore | undefined;
	now?: () => number;
}

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

function configuredMcpIds(settings: AgentSettings | null): Map<string, string> {
	if (!settings || !isRecord(settings.mcpServers)) return new Map();
	return new Map(
		Object.entries(settings.mcpServers)
			.filter(([, config]) => isRecord(config))
			.map(([mcpId]) => [mcpId, mcpId]),
	);
}

function configuredMcpIdForKnownConnector(
	ids: Map<string, string>,
	key: ToolboxMcpStatusConnectorKey,
): string | null {
	const aliases = connectorKeyAliases(key);
	const canonical = canonicalMcpIdForConnector(key);
	if (ids.has(canonical)) return canonical;
	for (const id of ids) {
		if (aliases.has(id[0])) return id[0];
	}
	return null;
}

async function statusFor(
	oauthStatusProvider: LobuOAuthStatusProvider | undefined,
	params: {
		agentId: string;
		userId: string;
		key: LobuConnectorKey;
		mcpId: string;
		configured: boolean;
	},
): Promise<LobuConnectorCurrentStatus> {
	let oauthStatus: LobuOAuthStatus = "unknown";
	if (oauthStatusProvider) {
		oauthStatus = await oauthStatusProvider.getOAuthStatus({
			agentId: params.agentId,
			userId: params.userId,
			connectorKey: params.key,
			mcpId: params.mcpId,
		});
	}
	const authorized = oauthStatus === "authorized";
	const uiManaged = isUiManagedMcp(String(params.key));

	return {
		key: params.key,
		oauthStatus,
		agentToolStatus: params.configured ? "usable" : "not_usable",
		configured: params.configured,
		authorized,
		reasonCode: statusReasonForConnector({
			configured: params.configured,
			authorized,
			oauthStatus,
			uiManaged,
		}),
		reauthorizationAvailable: uiManaged && params.configured,
		authorizationUrlAvailable: uiManaged && params.configured,
		uiManaged,
	};
}

function createStoredCredentialOAuthStatusProvider(
	getSecretStore: () => WritableSecretStore | undefined,
	now: () => number,
): LobuOAuthStatusProvider {
	return {
		async getOAuthStatus({ agentId, userId, mcpId }) {
			const secretStore = getSecretStore();
			if (!secretStore) return "unknown";
			try {
				const credential = await getStoredCredential(secretStore, agentId, userId, mcpId);
				if (!credential) return "not_connected";
				if (credential.expiresAt > now()) return "authorized";
				return "needs_reauth";
			} catch {
				return "unknown";
			}
		},
	};
}

function resolveOAuthStatusProvider(
	options: LobuConfigStatusServiceOptions,
): LobuOAuthStatusProvider | undefined {
	if (options.oauthStatusProvider) return options.oauthStatusProvider;
	if (!options.secretStore && !options.getSecretStore) return undefined;
	const getSecretStore = options.getSecretStore ?? (() => options.secretStore);
	return createStoredCredentialOAuthStatusProvider(
		getSecretStore,
		options.now ?? Date.now,
	);
}

export function createLobuConfigStatusService(
	options: LobuConfigStatusServiceOptions = {},
): LobuConfigStatusService {
	const store = options.store ?? createPostgresAgentConfigStore();
	const oauthStatusProvider = resolveOAuthStatusProvider(options);

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
			const connectors: LobuConnectorCurrentStatus[] = [];
			const knownIds = new Set<string>();
			for (const key of KNOWN_CONNECTORS) {
				const canonical = canonicalMcpIdForConnector(key);
				knownIds.add(canonical);
				for (const alias of connectorKeyAliases(key)) knownIds.add(alias);
				const configuredMcpId = configuredMcpIdForKnownConnector(ids, key);
				connectors.push(
					await statusFor(oauthStatusProvider, {
						agentId,
						userId,
						key,
						mcpId: configuredMcpId ?? canonical,
						configured: Boolean(configuredMcpId),
					}),
				);
			}
			for (const id of Array.from(ids.keys()).sort()) {
				if (!knownIds.has(id)) {
					connectors.push(
						await statusFor(oauthStatusProvider, {
							agentId,
							userId,
							key: id,
							mcpId: id,
							configured: true,
						}),
					);
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
