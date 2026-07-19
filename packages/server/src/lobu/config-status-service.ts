import { randomUUID } from "node:crypto";
import {
	type AgentConfigStore,
	type AgentMetadata,
	type AgentSettings,
	createBuiltinSecretRef,
} from "@lobu/core";
import type { WritableSecretStore } from "../gateway/secrets/index.js";
import {
	canonicalMcpIdForConnector,
	connectorKeyAliases,
	type ToolboxMcpStatusConnectorKey,
} from "./connector-mcp-resolver.js";
import {
	isUiManagedMcp,
	type ShifuMcpStatusReasonCode,
	statusReasonForConnector,
} from "./provisioning-routes.js";
import { orgContext } from "./stores/org-context.js";
import { createPostgresAgentConfigStore } from "./stores/postgres-stores.js";

export type LobuConnectorKey = ToolboxMcpStatusConnectorKey | (string & {});
export type LobuOAuthStatus =
	| "authorized"
	| "needs_reauth"
	| "not_connected"
	| "unknown";
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
	toolNames: string[];
	usable: boolean;
	runtimeReceiptRef: string | null;
}

export interface LobuConfigCurrentStatus {
	ok: true;
	agentId: string;
	userId: string;
	ownerUserId: string;
	checkedAt: number;
	contract: {
		name: "connector_runtime_observation";
		schemaVersion: 2;
	};
	runtimeReceiptRef: string;
	observedAt: string;
	expiresAt: string;
	connectors: LobuConnectorCurrentStatus[];
}

export interface LobuConfigStatusService {
	getCurrentStatus(input: {
		agentId: string;
		userId: string;
	}): Promise<LobuConfigCurrentStatus>;
}

export type LobuConfigStatusStore = Pick<
	AgentConfigStore,
	"getMetadata" | "getSettings"
>;

export interface LobuOAuthStatusProvider {
	getOAuthStatus(input: {
		agentId: string;
		userId: string;
		connectorKey: LobuConnectorKey;
		mcpId: string;
	}): Promise<LobuOAuthStatus>;
}

export interface LobuToolInventoryProvider {
	listToolNames(input: {
		agentId: string;
		userId: string;
		connectorKey: LobuConnectorKey;
		mcpId: string;
	}): Promise<readonly string[]>;
}

interface LobuConfigStatusServiceOptions {
	store?: LobuConfigStatusStore;
	oauthStatusProvider?: LobuOAuthStatusProvider;
	toolInventoryProvider?: LobuToolInventoryProvider;
	secretStore?: WritableSecretStore;
	getSecretStore?: () => WritableSecretStore | undefined;
	now?: () => number;
}

interface CredentialStatusInspection {
	authorized: boolean;
	credentialError: ShifuMcpStatusReasonCode | null;
}

interface StoredCredentialRecord {
	accessToken: string;
	expiresAt: number;
	refreshToken?: string;
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

function agentBelongsToToolboxUser(
	metadata: AgentMetadata,
	userId: string,
): boolean {
	return (
		metadata.owner?.platform === "toolbox" && metadata.owner.userId === userId
	);
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

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim() !== "",
			)
		: [];
}

function toolNameFromPattern(
	pattern: string,
	mcpId: string,
	allowUnqualified: boolean,
): string | null {
	const mcpPathPrefix = `/mcp/${mcpId}/tools/`;
	if (pattern.startsWith(mcpPathPrefix)) {
		const name = pattern.slice(mcpPathPrefix.length);
		return name && name !== "*" ? name : null;
	}
	const mcpFunctionPrefix = `mcp__${mcpId}__`;
	if (pattern.startsWith(mcpFunctionPrefix)) {
		const name = pattern.slice(mcpFunctionPrefix.length);
		return name && name !== "*" ? name : null;
	}
	if (
		allowUnqualified &&
		!pattern.includes("*") &&
		!pattern.startsWith("/mcp/") &&
		!pattern.startsWith("mcp__")
	) {
		return pattern;
	}
	return null;
}

function toolNamesForMcp(
	settings: AgentSettings | null,
	mcpId: string,
	options: { allowUnqualified: boolean },
): string[] {
	if (!settings) return [];
	const rawTools = [
		...stringArray((settings as { allowedTools?: unknown }).allowedTools),
		...stringArray(settings.preApprovedTools),
		...stringArray(settings.toolsConfig?.allowedTools),
	];
	return Array.from(
		new Set(
			rawTools
				.map((pattern) =>
					toolNameFromPattern(pattern, mcpId, options.allowUnqualified),
				)
				.filter((name): name is string => Boolean(name)),
		),
	).sort();
}

async function statusFor(
	deps: {
		oauthStatusProvider?: LobuOAuthStatusProvider;
		toolInventoryProvider?: LobuToolInventoryProvider;
		inspectCredentialStatus?: (input: {
			agentId: string;
			userId: string;
			mcpId: string;
		}) => Promise<CredentialStatusInspection>;
	},
	params: {
		agentId: string;
		userId: string;
		key: LobuConnectorKey;
		mcpId: string;
		configured: boolean;
		toolNames: string[];
		runtimeReceiptRef: string;
	},
): Promise<LobuConnectorCurrentStatus> {
	const uiManaged = isUiManagedMcp(String(params.key));
	let reasonCode: ShifuMcpStatusReasonCode;

	if (!params.configured) {
		reasonCode = statusReasonForConnector({
			configured: false,
			authorized: false,
			oauthStatus: "unknown",
			uiManaged,
		});
	} else if (deps.oauthStatusProvider) {
		const oauthStatus = await deps.oauthStatusProvider.getOAuthStatus({
			agentId: params.agentId,
			userId: params.userId,
			connectorKey: params.key,
			mcpId: params.mcpId,
		});
		reasonCode = statusReasonForConnector({
			configured: true,
			authorized: oauthStatus === "authorized",
			oauthStatus,
			uiManaged,
		});
	} else if (deps.inspectCredentialStatus && uiManaged) {
		const credentialStatus = await deps.inspectCredentialStatus({
			agentId: params.agentId,
			userId: params.userId,
			mcpId: params.mcpId,
		});
		reasonCode =
			credentialStatus.credentialError ??
			(credentialStatus.authorized ? "ok" : "missing_credential");
	} else {
		reasonCode = statusReasonForConnector({
			configured: params.configured,
			authorized: false,
			oauthStatus: "unknown",
			uiManaged,
		});
	}
	const oauthStatus = oauthStatusForReason(reasonCode);
	const authorized = oauthStatus === "authorized";
	let toolNames = params.toolNames;
	let runtimeInventoryObserved = false;
	if (deps.toolInventoryProvider) {
		toolNames = [];
		if (params.configured && authorized) {
			try {
				const runtimeToolNames = await deps.toolInventoryProvider.listToolNames({
					agentId: params.agentId,
					userId: params.userId,
					connectorKey: params.key,
					mcpId: params.mcpId,
				});
				if (
					runtimeToolNames.length <= 256 &&
					runtimeToolNames.every((name) =>
						/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name),
					)
				) {
					toolNames = [...new Set(runtimeToolNames)].sort();
					runtimeInventoryObserved = true;
				}
			} catch {
				// Runtime inventory is closed evidence: probe failure cannot become usable.
			}
		}
	}
	const usable =
		params.configured &&
		authorized &&
		runtimeInventoryObserved &&
		toolNames.length > 0;

	return {
		key: params.key,
		oauthStatus,
		// Keep the additive legacy projection honest: configured only means the
		// MCP exists. It is usable only after authorization and a successful
		// runtime inventory probe establish the v2 usable fact above.
		agentToolStatus: usable ? "usable" : "not_usable",
		configured: params.configured,
		authorized,
		reasonCode,
		reauthorizationAvailable: uiManaged && params.configured,
		authorizationUrlAvailable: uiManaged && params.configured,
		uiManaged,
		toolNames,
		usable,
		runtimeReceiptRef: usable
			? `${params.runtimeReceiptRef}:${params.key}`
			: null,
	};
}

function credentialSecretRef(
	agentId: string,
	userId: string,
	mcpId: string,
): string {
	return createBuiltinSecretRef(
		encodeURIComponent(`mcp-auth/${agentId}/${userId}/${mcpId}/credential`),
	);
}

function parseStoredCredential(value: string): StoredCredentialRecord | null {
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed)) return null;
	if (typeof parsed.accessToken !== "string") return null;
	if (
		typeof parsed.expiresAt !== "number" ||
		!Number.isFinite(parsed.expiresAt)
	) {
		return null;
	}
	return {
		accessToken: parsed.accessToken,
		expiresAt: parsed.expiresAt,
		...(typeof parsed.refreshToken === "string" &&
		parsed.refreshToken.length > 0
			? { refreshToken: parsed.refreshToken }
			: {}),
	};
}

async function inspectCredentialStatus(input: {
	agentId: string;
	userId: string;
	mcpId: string;
	getSecretStore: () => WritableSecretStore | undefined;
	now: () => number;
}): Promise<CredentialStatusInspection> {
	const secretStore = input.getSecretStore();
	if (!secretStore) {
		return { authorized: false, credentialError: "runtime_status_unavailable" };
	}
	try {
		const storedValue = await secretStore.get(
			credentialSecretRef(input.agentId, input.userId, input.mcpId),
		);
		if (!storedValue) return { authorized: false, credentialError: null };
		const credential = parseStoredCredential(storedValue);
		if (!credential) {
			return { authorized: false, credentialError: "provider_error" };
		}
		if (credential.expiresAt > input.now()) {
			return { authorized: true, credentialError: null };
		}
		// An expired access token with a refresh token is still a live grant:
		// the runtime refreshes it silently on the next tool call.
		if (credential.refreshToken) {
			return { authorized: true, credentialError: null };
		}
		return { authorized: false, credentialError: "token_expired" };
	} catch {
		return { authorized: false, credentialError: "provider_error" };
	}
}

function oauthStatusForReason(
	reasonCode: ShifuMcpStatusReasonCode,
): LobuOAuthStatus {
	if (reasonCode === "ok") return "authorized";
	if (
		reasonCode === "token_expired" ||
		reasonCode === "token_refresh_failed" ||
		reasonCode === "scope_missing"
	) {
		return "needs_reauth";
	}
	if (reasonCode === "missing_credential") return "not_connected";
	return "unknown";
}

function createStoredCredentialInspector(
	getSecretStore: () => WritableSecretStore | undefined,
	now: () => number,
): (input: {
	agentId: string;
	userId: string;
	mcpId: string;
}) => Promise<CredentialStatusInspection> {
	return (input) =>
		inspectCredentialStatus({
			...input,
			getSecretStore,
			now,
		});
}

function resolveStoredCredentialInspector(
	options: LobuConfigStatusServiceOptions,
):
	| ((input: {
			agentId: string;
			userId: string;
			mcpId: string;
	  }) => Promise<CredentialStatusInspection>)
	| undefined {
	if (options.oauthStatusProvider) return undefined;
	if (!options.secretStore && !options.getSecretStore) return undefined;
	const getSecretStore = options.getSecretStore ?? (() => options.secretStore);
	return createStoredCredentialInspector(
		getSecretStore,
		options.now ?? Date.now,
	);
}

export function createLobuConfigStatusService(
	options: LobuConfigStatusServiceOptions = {},
): LobuConfigStatusService {
	const store = options.store ?? createPostgresAgentConfigStore();
	const oauthStatusProvider = options.oauthStatusProvider;
	const toolInventoryProvider = options.toolInventoryProvider;
	const inspectStoredCredentialStatus =
		resolveStoredCredentialInspector(options);
	const now = options.now ?? Date.now;

	return {
		async getCurrentStatus({ agentId, userId }) {
			const metadata = await store.getMetadata(agentId);
			if (!metadata) {
				throw new LobuConfigStatusError("agent_not_found");
			}
			if (
				metadata.agentId !== agentId ||
				!agentBelongsToToolboxUser(metadata, userId)
			) {
				throw new LobuConfigStatusError("agent_owner_mismatch");
			}
			const ownerUserId = metadata.owner?.userId;
			if (!ownerUserId) {
				throw new LobuConfigStatusError("agent_owner_mismatch");
			}
			const buildStatus = async () => {
				const runtimeReceiptRef = `lobu:connector-runtime-observation:v2:${randomUUID()}`;
				const settings = await store.getSettings(agentId);
				const ids = configuredMcpIds(settings);
				const allowUnqualifiedToolNames = ids.size <= 1;
				const connectors: LobuConnectorCurrentStatus[] = [];
				const knownIds = new Set<string>();
				for (const key of KNOWN_CONNECTORS) {
					const canonical = canonicalMcpIdForConnector(key);
					knownIds.add(canonical);
					for (const alias of connectorKeyAliases(key)) knownIds.add(alias);
					const configuredMcpId = configuredMcpIdForKnownConnector(ids, key);
					connectors.push(
						await statusFor(
							{
								oauthStatusProvider,
								toolInventoryProvider,
								inspectCredentialStatus: inspectStoredCredentialStatus,
							},
							{
								agentId,
								userId,
								key,
								mcpId: configuredMcpId ?? canonical,
								configured: Boolean(configuredMcpId),
								toolNames: toolNamesForMcp(
									settings,
									configuredMcpId ?? canonical,
									{
										allowUnqualified: allowUnqualifiedToolNames,
									},
								),
								runtimeReceiptRef,
							},
						),
					);
				}
				for (const id of Array.from(ids.keys()).sort()) {
					if (!knownIds.has(id)) {
						connectors.push(
							await statusFor(
								{
									oauthStatusProvider,
									toolInventoryProvider,
									inspectCredentialStatus: inspectStoredCredentialStatus,
								},
								{
									agentId,
									userId,
									key: id,
									mcpId: id,
									configured: true,
									toolNames: toolNamesForMcp(settings, id, {
										allowUnqualified: allowUnqualifiedToolNames,
									}),
									runtimeReceiptRef,
								},
							),
						);
					}
				}

				const observedAtMs = now();
				const observedAt = new Date(observedAtMs).toISOString();
				const expiresAt = new Date(observedAtMs + 5 * 60_000).toISOString();
				return {
					ok: true as const,
					agentId,
					userId,
					ownerUserId,
					checkedAt: observedAtMs,
					contract: {
						name: "connector_runtime_observation" as const,
						schemaVersion: 2 as const,
					},
					runtimeReceiptRef,
					observedAt,
					expiresAt,
					connectors,
				};
			};
			return metadata.organizationId
				? orgContext.run(
						{ organizationId: metadata.organizationId },
						buildStatus,
					)
				: buildStatus();
		},
	};
}
