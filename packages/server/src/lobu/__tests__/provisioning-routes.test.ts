import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import { canonicalize } from "json-canonicalize";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context.js";
import {
	installRouteAuthTestMock,
	useRealRouteStores,
} from "./helpers/route-test-mocks.js";

// Workspace initialization reaches agent-routes through auth notifications.
installRouteAuthTestMock();
useRealRouteStores();

const ORG_ID = "org-provisioning";

const startAuthCodeFlowMock = mock(async () => ({
	authorizationUrl: "https://auth.example.test/authorize?state=test-state",
	state: "test-state",
}));

mock.module("../../gateway/auth/mcp/oauth-flow.js", () => ({
	completeAuthCodeFlow: async () => ({
		ok: true,
		credentialRef: "secret://oauth-test",
	}),
	getOAuthCallbackCookie: () => null,
	startAuthCodeFlow: startAuthCodeFlowMock,
}));

mock.module("../../index", () => ({}));
mock.module("../../index.js", () => ({}));

mock.module("@lobu/connector-sdk", () => ({
	AssuranceLevel: Type.Any(),
	AutoCreateWhenRule: Type.Any(),
	CLAIM_COLLISION_SEMANTIC_TYPE: "claim_collision",
	ClaimCollisionPayload: Type.Any(),
	ConnectorFact: Type.Any(),
	ConnectorIdentityCapability: Type.Any(),
	DerivedFromProvenance: Type.Any(),
	DerivedRelationshipMetadata: Type.Any(),
	FactEventMetadata: Type.Any(),
	IDENTITY: {},
	IDENTITY_FACT_SEMANTIC_TYPE: "identity_fact",
	RelationshipTypeIdentityMetadata: Type.Any(),
	WATCHER_TIME_GRANULARITIES: ["daily"],
	addWatcherPeriod: (date: Date) => date,
	alignToWatcherWindowStart: (date: Date) => date,
	assuranceMeets: () => true,
	getAvailableWatcherGranularities: () => ["daily"],
	getFinerWatcherGranularities: () => [],
	normalizeAuthUserId: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim().toLowerCase() : null,
	normalizeEmail: (value: string | null | undefined) =>
		typeof value === "string" && value.includes("@")
			? value.trim().toLowerCase()
			: null,
	normalizeGithubLogin: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim().toLowerCase() : null,
	normalizeGithubRepoFullName: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim().toLowerCase() : null,
	normalizeGoogleContactId: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim() : null,
	normalizeIdentifier: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim().toLowerCase() : null,
	normalizeNumericId: (value: string | number | null | undefined) =>
		value === null || value === undefined ? null : String(value).trim(),
	normalizePhone: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim() : null,
	normalizeSlackUserId: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim() : null,
	normalizeWaJid: (value: string | null | undefined) =>
		typeof value === "string" ? value.trim() : null,
	inferWatcherGranularityFromDays: () => "daily",
	inferWatcherGranularityFromSchedule: () => "daily",
	getNextWatcherGranularity: () => "daily",
	getWatcherDateTruncUnit: () => "day",
	isWatcherTimeGranularity: () => true,
	shiftWatcherPeriod: (date: Date) => date,
	subtractWatcherPeriod: (date: Date) => date,
}));

mock.module("../../utils/watcher-reactions", () => ({
	getAvailableOperations: async () => [],
	getPastReactionsSummary: async () => undefined,
	trackWatcherReaction: async () => {},
}));

mock.module("../../gateway/routes/internal/device-auth.js", () => {
	function credentialName(
		agentId: string,
		userId: string,
		mcpId: string,
	): string {
		return `mcp-auth/${agentId}/${userId}/${mcpId}/credential`;
	}

	async function getSecretCredential(
		secretStore: ReturnType<typeof createMemorySecretStore>,
		agentId: string,
		userId: string,
		mcpId: string,
	) {
		const raw = await secretStore.get(
			`secret://${encodeURIComponent(credentialName(agentId, userId, mcpId))}`,
		);
		return raw ? JSON.parse(raw) : null;
	}

	async function putSecretCredential(
		secretStore: ReturnType<typeof createMemorySecretStore>,
		agentId: string,
		userId: string,
		mcpId: string,
		credential: unknown,
	) {
		await secretStore.put(
			credentialName(agentId, userId, mcpId),
			JSON.stringify(credential),
		);
	}

	function getStableCredentialBindingId(credential: {
		bindingId?: string;
		refreshToken?: string;
		clientId: string;
		tokenUrl: string;
		resource?: string;
		tokenEndpointAuthMethod?: string;
	}) {
		return (
			credential.bindingId ??
			createHash("sha256")
				.update(
					JSON.stringify({
						refreshToken: credential.refreshToken ?? null,
						clientId: credential.clientId,
						tokenUrl: credential.tokenUrl,
						resource: credential.resource ?? null,
						tokenEndpointAuthMethod:
							credential.tokenEndpointAuthMethod ?? null,
					}),
				)
				.digest("hex")
		);
	}

	return {
		createDeviceAuthRoutes: () => new Hono(),
		getStableCredentialBindingId,
		deleteCredential: async (
			secretStore: ReturnType<typeof createMemorySecretStore>,
			agentId: string,
			userId: string,
			mcpId: string,
		) => {
			await secretStore.delete(credentialName(agentId, userId, mcpId));
			return true;
		},
		getStoredCredential: getSecretCredential,
		refreshCredential: async (
			secretStore: ReturnType<typeof createMemorySecretStore>,
			agentId: string,
			userId: string,
			mcpId: string,
			credential: {
				refreshToken?: string;
				clientId: string;
				clientSecret?: string;
				tokenUrl: string;
				resource?: string;
			},
		) => {
			if (!credential.refreshToken) return null;
			const response = await fetch(credential.tokenUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					grant_type: "refresh_token",
					client_id: credential.clientId,
					client_secret: credential.clientSecret,
					refresh_token: credential.refreshToken,
					resource: credential.resource,
				}),
			});
			if (!response.ok) return null;
			const token = await response.json();
			const refreshed = {
				...credential,
				bindingId: getStableCredentialBindingId(credential),
				accessToken: String(token.access_token ?? ""),
				refreshToken: token.refresh_token
					? String(token.refresh_token)
					: credential.refreshToken,
				expiresAt: Date.now() + Number(token.expires_in ?? 3600) * 1000,
			};
			await putSecretCredential(secretStore, agentId, userId, mcpId, refreshed);
			return refreshed;
		},
		startDeviceAuth: async () => null,
		storeCredentialForScope: async (
			secretStore: ReturnType<typeof createMemorySecretStore>,
			agentId: string,
			scopeKey: string,
			mcpId: string,
			credential: unknown,
		) => putSecretCredential(secretStore, agentId, scopeKey, mcpId, credential),
		tryCompletePendingDeviceAuth: async () => null,
	};
});

mock.module("@lobu/connector-worker/compile", () => ({
	EXTERNAL_RUNTIME_DEPS: [],
	assertExternalDepsResolvable: () => {},
	createConnectorCompiler: () => ({
		compile: async () => ({
			code: "",
			metadata: {},
			warnings: [],
		}),
	}),
	findBundledConnectorFile: () => null,
}));

mock.module("@lobu/connector-worker/executor/runtime", () => ({
	executeCompiledConnector: async () => ({
		mode: "query",
		rows: [],
		columns: [],
	}),
}));

mock.module("../../operations/catalog", () => ({
	EMPTY_SUMMARY: {
		read: [],
		write: [],
	},
	getOperationForConnection: async () => null,
	getOperationsSummary: async () => ({
		read: [],
		write: [],
	}),
	getOperationsSummaryBatch: async () => new Map(),
	listOperations: async () => ({ operations: [], total: 0 }),
}));

beforeAll(async () => {
	await ensureDbForGatewayTests();
	const { initWorkspaceProvider } = await import("../../workspace/index.js");
	await initWorkspaceProvider();
});

async function seedOrg(orgId: string): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
}

function createMemorySecretStore(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		async get(ref: string) {
			const encoded = ref.startsWith("secret://")
				? ref.slice("secret://".length)
				: ref;
			return store.get(decodeURIComponent(encoded)) ?? null;
		},
		async put(name: string, value: string) {
			store.set(name, value);
			return `secret://${encodeURIComponent(name)}`;
		},
		async delete(nameOrRef: string) {
			const encoded = nameOrRef.startsWith("secret://")
				? nameOrRef.slice("secret://".length)
				: nameOrRef;
			store.delete(decodeURIComponent(encoded));
		},
		async list() {
			return [];
		},
	};
}

async function buildApp(
	scopes: string[] = ["mcp:admin"],
	overrides: {
		mcpConfigService?: {
			getHttpServer: (mcpId: string, agentId?: string) => Promise<unknown>;
		};
		secretStore?: ReturnType<typeof createMemorySecretStore>;
		publicGatewayUrl?: string;
		agentConfigurationAuthority?: unknown;
		runtimeCapabilitySnapshotResolver?: unknown;
		agentReleaseEnvironment?: string;
		agentConfigurationTransactionHooks?: {
			beforeAgentLock?: () => Promise<void>;
		};
		authUserId?: string;
	} = {},
) {
	const { createProvisioningRoutes } = await import(
		"../provisioning-routes.js"
	);
	const app = new Hono();
	app.onError((_error, c) => c.json({ error: "internal_error" }, 500));
	app.use("*", async (c, next) => {
		const authUserId = overrides.authUserId ?? "gateway-user";
		c.set("user", {
			id: authUserId,
			name: "Gateway User",
			email: "gateway@example.test",
			emailVerified: true,
		});
		c.set("session", {
			id: "pat:test-client",
			userId: authUserId,
			token: "owl_pat_test",
			expiresAt: new Date(Date.now() + 60_000),
			activeOrganizationId: ORG_ID,
		});
		c.set("organizationId", ORG_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId: ORG_ID }, next);
	});
	app.route(
		"/api/provisioning",
		createProvisioningRoutes({
			mcpConfigService: overrides.mcpConfigService as never,
			secretStore: overrides.secretStore as never,
			publicGatewayUrl:
				overrides.publicGatewayUrl ?? "https://gateway.example.test/lobu",
			agentConfigurationAuthority:
				overrides.agentConfigurationAuthority as never,
			runtimeCapabilitySnapshotResolver:
				overrides.runtimeCapabilitySnapshotResolver as never,
			agentReleaseEnvironment: overrides.agentReleaseEnvironment,
			agentConfigurationTransactionHooks:
				overrides.agentConfigurationTransactionHooks,
		}),
	);
	return app;
}

const ENROLLMENT_ROUTE_AGENT_ID = "shifu-u-enrollment-route";
const ENROLLMENT_ROUTE_USER_ID = "toolbox-user-enrollment";
const ENROLLMENT_CAPABILITY_ID = "agent_configuration_authority.v1";

function enrollmentRouteSnapshot(
	overrides: Partial<{
		environment: "staging" | "production";
		toolboxUserId: string;
		agentId: string;
		capabilities: string[];
		appliedReleaseId: string;
		appliedReleaseSequence: number;
		expiresAt: string;
	}> = {},
) {
	const unsigned = {
		schemaVersion: 1 as const,
		environment: overrides.environment ?? ("production" as const),
		toolboxUserId: overrides.toolboxUserId ?? ENROLLMENT_ROUTE_USER_ID,
		agentId: overrides.agentId ?? ENROLLMENT_ROUTE_AGENT_ID,
		capabilities: overrides.capabilities ?? [ENROLLMENT_CAPABILITY_ID],
		appliedReleaseId:
			overrides.appliedReleaseId ?? "agent-release-enrollment-route-4",
		appliedReleaseSequence: overrides.appliedReleaseSequence ?? 4,
		expiresAt:
			overrides.expiresAt ?? new Date(Date.now() + 30_000).toISOString(),
	};
	return {
		...unsigned,
		snapshotDigest: `sha256:${createHash("sha256")
			.update(canonicalize(unsigned))
			.digest("hex")}`,
	};
}

async function seedEnrollmentRouteTruth(): Promise<string> {
	await seedPersonalAgent(ENROLLMENT_ROUTE_AGENT_ID, ENROLLMENT_ROUTE_USER_ID);
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const managedSettings = {
		identityMd: "route managed identity",
		soulMd: "route managed soul",
		userMd: "route managed user",
		modelSelection: { mode: "auto" },
		toolsConfig: { strictMode: true },
	};
	const settingsHash = `sha256:${createHash("sha256")
		.update(canonicalize(managedSettings))
		.digest("hex")}`;
	await sql`
		UPDATE agents SET identity_md = ${managedSettings.identityMd},
			soul_md = ${managedSettings.soulMd}, user_md = ${managedSettings.userMd},
			model_selection = ${sql.json(managedSettings.modelSelection)},
			tools_config = ${sql.json(managedSettings.toolsConfig)}
		WHERE organization_id = ${ORG_ID} AND id = ${ENROLLMENT_ROUTE_AGENT_ID}
	`;
	await sql`
		INSERT INTO agent_release_applies (
			organization_id, agent_id, environment,
			desired_release_id, desired_release_sequence, desired_feed_sequence,
			applied_release_id, applied_release_sequence, applied_feed_sequence,
			applied_channel, applied_feed_digest, manifest_digest, status,
			revision_ref, settings_hash
		) VALUES (
			${ORG_ID}, ${ENROLLMENT_ROUTE_AGENT_ID}, 'production',
			'agent-release-enrollment-route-4', 4, 9,
			'agent-release-enrollment-route-4', 4, 9,
			'candidate', ${`sha256:${"c".repeat(64)}`}, ${`sha256:${"d".repeat(64)}`},
			'applied', 'lobu:enrollment-route:4', ${settingsHash}
		)
	`;
	return settingsHash;
}

function requestManagedEnrollment(
	app: Hono,
	input: {
		commandId?: string;
		revision?: string;
		toolboxUserId?: string;
	} = {},
): Promise<Response> {
	return app.request(
		`/api/provisioning/agents/${ENROLLMENT_ROUTE_AGENT_ID}/configuration-management/enroll`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"if-match": `"agent-config:${input.revision ?? "0"}"`,
				"idempotency-key": input.commandId ?? "managed-enrollment-route-command-1",
			},
			body: JSON.stringify({
				toolboxUserId: input.toolboxUserId ?? ENROLLMENT_ROUTE_USER_ID,
				environment: "production",
			}),
		},
	);
}

describe("POST /api/provisioning/agents/:agentId/configuration-management/enroll", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("resolves a fresh target snapshot before delegating managed enrollment", async () => {
		const callOrder: string[] = [];
		const snapshot = {
			schemaVersion: 1,
			environment: "production",
			toolboxUserId: "toolbox-user-enrollment",
			agentId: "shifu-u-enrollment-route",
			capabilities: ["agent_configuration_authority.v1"],
			appliedReleaseId: "agent-release-4",
			appliedReleaseSequence: 4,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		};
		const runtimeCapabilitySnapshotResolver = mock(async () => {
			callOrder.push("snapshot");
			return snapshot;
		});
		const enrollToolboxManaged = mock(async () => {
			callOrder.push("authority");
			return {
				status: "applied",
				state: {
					managementMode: "toolbox_managed",
					configurationRevision: "1",
					settingsDigest: `sha256:${"b".repeat(64)}`,
				},
			};
		});
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver,
			agentConfigurationAuthority: {
				apply: async () => ({ status: "rejected", reason: "invalid_release" }),
				applyManagedRelease: async () => {
					throw new Error("not used");
				},
				enrollToolboxManaged,
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"if-match": '"agent-config:0"',
					"idempotency-key": "managed-enrollment-command-1",
				},
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(callOrder).toEqual(["snapshot", "authority"]);
		expect(runtimeCapabilitySnapshotResolver).toHaveBeenCalledWith(
			{
				environment: "production",
				toolboxUserId: "toolbox-user-enrollment",
				agentId: "shifu-u-enrollment-route",
			},
			{ bypassCache: true },
		);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			status: "applied",
			managementMode: "toolbox_managed",
			configurationRevision: "1",
		});
	});

	test.each([
		["missing If-Match", {}, "agent_configuration_revision_required"],
		["invalid If-Match", { "if-match": "agent-config:0" }, "invalid_revision_precondition"],
		["missing Idempotency-Key", { "if-match": '"agent-config:0"' }, "missing_idempotency_key"],
		["invalid Idempotency-Key", {
			"if-match": '"agent-config:0"',
			"idempotency-key": "contains spaces",
		}, "invalid_idempotency_key"],
	])("rejects %s before resolving a snapshot", async (_name, headers, error) => {
		const resolver = mock(async () => {
			throw new Error("must not be called");
		});
		const enrollToolboxManaged = mock(async () => {
			throw new Error("must not be called");
		});
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: resolver,
			agentConfigurationAuthority: {
				enrollToolboxManaged,
				apply: async () => ({ status: "rejected" }),
				applyManagedRelease: async () => ({ evidence: {}, state: {} }),
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error });
		expect(resolver).not.toHaveBeenCalled();
		expect(enrollToolboxManaged).not.toHaveBeenCalled();
	});

	test("rejects malformed enrollment bodies before resolving a snapshot", async () => {
		const resolver = mock(async () => {
			throw new Error("must not be called");
		});
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: resolver,
		});
		for (const body of [
			{},
			{ toolboxUserId: "", environment: "production" },
			{ toolboxUserId: "toolbox-user-enrollment", environment: "local" },
			{ toolboxUserId: "toolbox-user-enrollment", environment: "production", extra: true },
		]) {
			const response = await app.request(
				"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"if-match": '"agent-config:0"',
						"idempotency-key": "managed-enrollment-command-invalid-body",
					},
					body: JSON.stringify(body),
				},
			);
			expect(response.status).toBe(400);
		}
		expect(resolver).not.toHaveBeenCalled();
	});

	test.each([
		["capability_inactive", "agent_configuration_capability_inactive"],
		["stale_release", "agent_configuration_stale_release"],
		["invalid_release", "agent_configuration_invalid_release"],
		["environment_mismatch", "agent_configuration_environment_mismatch"],
		["enrollment_drifted", "agent_configuration_enrollment_drifted"],
	])("maps the %s domain rejection to a safe 409 response", async (reason, error) => {
		const snapshot = {
			schemaVersion: 1,
			environment: "production",
			toolboxUserId: "toolbox-user-enrollment",
			agentId: "shifu-u-enrollment-route",
			capabilities: ["agent_configuration_authority.v1"],
			appliedReleaseId: "agent-release-4",
			appliedReleaseSequence: 4,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			snapshotDigest: `sha256:${"a".repeat(64)}`,
		};
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => snapshot,
			agentConfigurationAuthority: {
				enrollToolboxManaged: async () => ({ status: "rejected", reason }),
				apply: async () => ({ status: "rejected" }),
				applyManagedRelease: async () => ({ evidence: {}, state: {} }),
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"if-match": '"agent-config:0"',
					"idempotency-key": `managed-enrollment-${reason}`,
				},
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({ error });
	});

	test("returns stable replay and already-managed no-op responses", async () => {
		const results = [
			{
				status: "already_applied",
				state: {
					managementMode: "toolbox_managed",
					configurationRevision: "1",
					settingsDigest: `sha256:${"b".repeat(64)}`,
				},
			},
			{
				status: "already_managed",
				managementMode: "toolbox_managed",
				configurationRevision: "1",
			},
		];
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => ({
				schemaVersion: 1,
				environment: "production",
				toolboxUserId: "toolbox-user-enrollment",
				agentId: "shifu-u-enrollment-route",
				capabilities: ["agent_configuration_authority.v1"],
				appliedReleaseId: "agent-release-4",
				appliedReleaseSequence: 4,
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
				snapshotDigest: `sha256:${"a".repeat(64)}`,
			}),
			agentConfigurationAuthority: {
				enrollToolboxManaged: async () => results.shift(),
				apply: async () => ({ status: "rejected" }),
				applyManagedRelease: async () => ({ evidence: {}, state: {} }),
			},
		});
		const request = (key: string) => app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"if-match": '"agent-config:0"',
					"idempotency-key": key,
				},
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);
		const replay = await request("managed-enrollment-replay");
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({
			status: "already_applied",
			managementMode: "toolbox_managed",
			configurationRevision: "1",
		});
		const alreadyManaged = await request("managed-enrollment-other-command");
		expect(alreadyManaged.status).toBe(200);
		await expect(alreadyManaged.json()).resolves.toEqual({
			ok: true,
			status: "no_change",
			reason: "already_toolbox_managed",
			managementMode: "toolbox_managed",
			configurationRevision: "1",
		});
	});

	test("fails closed when the fresh snapshot transport fails", async () => {
		const enrollToolboxManaged = mock(async () => ({ status: "applied" }));
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => {
				throw new Error("private transport detail");
			},
			agentConfigurationAuthority: {
				enrollToolboxManaged,
				apply: async () => ({ status: "rejected" }),
				applyManagedRelease: async () => ({ evidence: {}, state: {} }),
			},
		});
		const response = await app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"if-match": '"agent-config:0"',
					"idempotency-key": "managed-enrollment-transport-failure",
				},
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "agent_configuration_capability_snapshot_unavailable",
		});
		expect(enrollToolboxManaged).not.toHaveBeenCalled();
	});

	test("rejects a PAT without mcp:admin before snapshot resolution", async () => {
		const resolver = mock(async () => ({}));
		const app = await buildApp([], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: resolver,
		});
		const response = await app.request(
			"/api/provisioning/agents/shifu-u-enrollment-route/configuration-management/enroll",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"if-match": '"agent-config:0"',
					"idempotency-key": "managed-enrollment-no-scope",
				},
				body: JSON.stringify({
					toolboxUserId: "toolbox-user-enrollment",
					environment: "production",
				}),
			},
		);
		expect(response.status).toBe(403);
		expect(resolver).not.toHaveBeenCalled();
	});

	test("enrolls and replays against real durable release truth", async () => {
		const settingsHash = await seedEnrollmentRouteTruth();
		let snapshotGeneration = 0;
		const resolvedSnapshotDigests: string[] = [];
		const resolver = mock(async () => {
			snapshotGeneration += 1;
			const snapshot = enrollmentRouteSnapshot({
				expiresAt: new Date(Date.now() + 20_000 + snapshotGeneration * 5_000).toISOString(),
			});
			resolvedSnapshotDigests.push(snapshot.snapshotDigest);
			return snapshot;
		});
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: resolver,
		});

		const applied = await requestManagedEnrollment(app);
		expect(applied.status).toBe(200);
		await expect(applied.json()).resolves.toEqual({
			ok: true,
			status: "applied",
			managementMode: "toolbox_managed",
			configurationRevision: "1",
			settingsDigest: settingsHash,
		});
		const replay = await requestManagedEnrollment(app);
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({
			status: "already_applied",
			configurationRevision: "1",
		});
		expect(new Set(resolvedSnapshotDigests).size).toBe(2);
		const alreadyManaged = await requestManagedEnrollment(app, {
			commandId: "managed-enrollment-route-command-2",
			revision: "1",
		});
		expect(alreadyManaged.status).toBe(200);
		await expect(alreadyManaged.json()).resolves.toEqual({
			ok: true,
			status: "no_change",
			reason: "already_toolbox_managed",
			managementMode: "toolbox_managed",
			configurationRevision: "1",
		});
		const rows = await (await import("../../db/client.js")).getDb()`
			SELECT c.management_mode, c.configuration_revision,
			       (SELECT count(*)::int FROM agent_configuration_commands command_row
			        WHERE command_row.organization_id = c.organization_id
			          AND command_row.agent_id = c.agent_id) AS command_count
			FROM agent_configuration_controls c
			WHERE c.organization_id = ${ORG_ID} AND c.agent_id = ${ENROLLMENT_ROUTE_AGENT_ID}
		`;
		expect(rows).toEqual([{
			management_mode: "toolbox_managed",
			configuration_revision: 1,
			command_count: 1,
		}]);
	});

	test("seals broad and fenced bootstrap before any side effect after durable enrollment", async () => {
		await seedEnrollmentRouteTruth();
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => enrollmentRouteSnapshot(),
		});
		expect((await requestManagedEnrollment(app)).status).toBe(200);
		const sql = (await import("../../db/client.js")).getDb();
		const snapshot = async () => ({
			agent: await sql`
				SELECT name, description, owner_platform, owner_user_id, user_md
				FROM agents WHERE organization_id = ${ORG_ID} AND id = ${ENROLLMENT_ROUTE_AGENT_ID}
			`,
			users: await sql`SELECT id FROM "user" WHERE id IN ('sealed-broad-owner', 'toolbox-user-fenced')`,
			members: await sql`
				SELECT "userId", role FROM "member"
				WHERE "organizationId" = ${ORG_ID}
				  AND "userId" IN ('sealed-broad-owner', 'toolbox-user-fenced')
			`,
			owners: await sql`
				SELECT platform, user_id FROM agent_users
				WHERE organization_id = ${ORG_ID} AND agent_id = ${ENROLLMENT_ROUTE_AGENT_ID}
				ORDER BY platform, user_id
			`,
			grants: await sql`
				SELECT kind, pattern FROM grants
				WHERE organization_id = ${ORG_ID} AND agent_id = ${ENROLLMENT_ROUTE_AGENT_ID}
			`,
			fences: await sql`
				SELECT target_id FROM agent_provisioning_fences
				WHERE organization_id = ${ORG_ID} AND agent_id = ${ENROLLMENT_ROUTE_AGENT_ID}
			`,
			lifecycle: await sql`
				SELECT id FROM events
				WHERE organization_id = ${ORG_ID}
				  AND metadata->>'entity_id' = ${ENROLLMENT_ROUTE_AGENT_ID}
			`,
		});
		const before = await snapshot();

		const broad = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: ENROLLMENT_ROUTE_AGENT_ID,
				name: "must not mutate",
				ownerUserId: "sealed-broad-owner",
				settings: { userMd: "must not mutate" },
			}),
		});
		expect(broad.status).toBe(409);
		await expect(broad.json()).resolves.toMatchObject({
			error: "agent_settings_managed_by_release",
		});
		const fenced = await putFencedAgent(
			app,
			ENROLLMENT_ROUTE_AGENT_ID,
			fencedProvisioningBody({ settings: { userMd: "must not mutate" } }),
		);
		expect(fenced.status).toBe(409);
		await expect(fenced.json()).resolves.toEqual({
			error: "agent_settings_managed_by_release",
		});
		expect(await snapshot()).toEqual(before);
	});

	test.each([
		["capability absent", enrollmentRouteSnapshot({ capabilities: ["other.v1"] }), undefined, "agent_configuration_capability_inactive"],
		["release id mismatch", enrollmentRouteSnapshot({ appliedReleaseId: "agent-release-enrollment-route-5" }), undefined, "agent_configuration_stale_release"],
		["release sequence mismatch", enrollmentRouteSnapshot({ appliedReleaseSequence: 5 }), undefined, "agent_configuration_stale_release"],
		["Toolbox user mismatch", enrollmentRouteSnapshot({ toolboxUserId: "another-user" }), undefined, "agent_configuration_invalid_release"],
		["agent mismatch", enrollmentRouteSnapshot({ agentId: "shifu-u-another-route-agent" }), undefined, "agent_configuration_invalid_release"],
		["environment mismatch", enrollmentRouteSnapshot({ environment: "staging" }), undefined, "agent_configuration_environment_mismatch"],
		["durable owner mismatch", enrollmentRouteSnapshot({ toolboxUserId: "another-user" }), "another-user", "agent_configuration_invalid_release"],
		["stale snapshot", enrollmentRouteSnapshot({ expiresAt: "2000-01-01T00:00:00.000Z" }), undefined, "agent_configuration_stale_release"],
	])("fails closed for %s through the real authority", async (_name, snapshot, toolboxUserId, error) => {
		await seedEnrollmentRouteTruth();
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => snapshot,
		});
		const response = await requestManagedEnrollment(app, { toolboxUserId });
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({ error });
		const control = (await (await import("../../db/client.js")).getDb()`
			SELECT management_mode, configuration_revision
			FROM agent_configuration_controls
			WHERE organization_id = ${ORG_ID} AND agent_id = ${ENROLLMENT_ROUTE_AGENT_ID}
		`)[0];
		expect(control).toEqual({ management_mode: "native", configuration_revision: 0 });
	});

	test("detects live settings drift through the release truth classifier", async () => {
		await seedEnrollmentRouteTruth();
		const sql = (await import("../../db/client.js")).getDb();
		await sql`
			UPDATE agents SET user_md = 'route drift'
			WHERE organization_id = ${ORG_ID} AND id = ${ENROLLMENT_ROUTE_AGENT_ID}
		`;
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => enrollmentRouteSnapshot(),
		});
		const response = await requestManagedEnrollment(app);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "agent_configuration_enrollment_drifted",
		});
	});

	test("completes snapshot resolution before the authority transaction reaches its pre-lock hook", async () => {
		await seedEnrollmentRouteTruth();
		const order: string[] = [];
		const app = await buildApp(["mcp:admin"], {
			agentReleaseEnvironment: "production",
			runtimeCapabilitySnapshotResolver: async () => {
			order.push("snapshot-start");
			await Promise.resolve();
			order.push("snapshot-complete");
			return enrollmentRouteSnapshot();
		},
			agentConfigurationTransactionHooks: {
			beforeAgentLock: async () => {
				order.push("transaction-before-agent-lock");
			},
		},
		});
		const response = await requestManagedEnrollment(app);
		expect(response.status).toBe(200);
		expect(order).toEqual([
			"snapshot-start",
			"snapshot-complete",
			"transaction-before-agent-lock",
		]);
	});
});

describe("PUT /api/provisioning/agents/:agentId/managed-settings", () => {
	test("delegates signed managed release mutation to the injected configuration authority", async () => {
		const applyManagedRelease = mock(async () => ({
			evidence: {
				ok: true,
				marker: "authority-release-evidence",
			},
			state: { configurationRevision: "7", managementMode: "native" },
		}));
		const app = await buildApp(["mcp:admin"], {
			agentConfigurationAuthority: {
				apply: async () => ({ status: "rejected", reason: "invalid_release" }),
				applyManagedRelease,
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-authority-route/managed-settings",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ signedReleaseFixture: true }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			marker: "authority-release-evidence",
		});
		expect(applyManagedRelease).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			agentId: "shifu-u-authority-route",
			command: { signedReleaseFixture: true },
			actor: { kind: "release" },
		});
	});
});

const FENCE_TARGET_ID = "a49ef354-e14f-4b42-a030-bd5f9a78f17f";
const FENCE_TOKEN_A = "02a3b3ca-e30a-4c3f-8317-2a5da9b4a52a";
const FENCE_TOKEN_B = "d9dd602c-f99f-4457-958c-67d2d89e922c";
const BASELINE_VERSION_ID = `personal-agent-baseline-v1-${"a".repeat(64)}`;
const EFFECTIVE_SETTINGS_DIGEST = `sha256:${"b".repeat(64)}`;

function fencedProvisioningBody(
	input: {
		claimGeneration?: number;
		claimToken?: string;
		name?: string;
		settings?: Record<string, unknown>;
	} = {},
) {
	return {
		name: input.name ?? "Fenced personal agent",
		description: "Provisioned from the reviewed baseline",
		ownerUserId: "toolbox-user-fenced",
		targetId: FENCE_TARGET_ID,
		claimGeneration: input.claimGeneration ?? 1,
		claimToken: input.claimToken ?? FENCE_TOKEN_A,
		baselineVersionId: BASELINE_VERSION_ID,
		effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST,
		settings: input.settings ?? { userMd: "generation one" },
	};
}

async function putFencedAgent(
	app: Hono,
	agentId: string,
	body: unknown,
): Promise<Response> {
	return app.request(
		`/api/provisioning/agents/${encodeURIComponent(agentId)}/fenced-settings`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

async function seedPersonalAgent(
	agentId = "shifu-u-abc123",
	ownerUserId = "toolbox-user-1",
) {
	const { createPostgresAgentConfigStore } = await import(
		"../stores/postgres-stores.js"
	);
	const store = createPostgresAgentConfigStore();
	await orgContext.run({ organizationId: ORG_ID }, async () => {
		await store.saveMetadata(agentId, {
			agentId,
			name: "Toolbox Owner Agent",
			owner: { platform: "toolbox", userId: ownerUserId },
			organizationId: ORG_ID,
			isWorkspaceAgent: false,
			createdAt: Date.now(),
		});
	});
}

function deterministicMembershipId(
	organizationId: string,
	ownerUserId: string,
): string {
	const digest = createHash("sha256")
		.update(
			JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId]),
		)
		.digest("hex")
		.slice(0, 24);
	return `member_${digest}`;
}

function contextPackBody(agentId: string, ownerUserId: string) {
	return {
		ownerUserId,
		agentId,
		title: "Toolbox onboarding context pack",
		summary: "Project summary",
		content: "# Toolbox onboarding\n\nProject context.",
		semanticType: "project_profile",
		metadata: {
			source: "toolbox_onboarding",
			contextPackId: "ctx-provisioned-owner",
			projectSeedId: null,
			discoveryRunId: null,
			projectTitle: "Toolbox onboarding",
			confidence: "high",
			generatedAt: "2026-06-18T00:00:00.000Z",
			evidenceRefs: [],
		},
	};
}

describe("POST /api/provisioning/agents", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("upserts a shifu user agent with settings under the PAT organization", async () => {
		const app = await buildApp();

		const first = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-abc123",
				name: "PM / Marketing Agent",
				description: "Onboards product context",
				settings: {
					model: "anthropic/claude-sonnet-4-5",
					identityMd: "You are ShiFu.",
					userMd: "Ask onboarding questions.",
					networkConfig: { allowedDomains: ["*"] },
					mcpServers: {
						"lobu-memory": {
							type: "streamable-http",
							url: "https://example.test/mcp/shifu-install",
						},
					},
					preApprovedTools: ["/mcp/lobu-memory/tools/*"],
				},
			}),
		});

		expect(first.status).toBe(201);
		await expect(first.json()).resolves.toMatchObject({
			ok: true,
			agentId: "shifu-u-abc123",
			created: true,
			revisionRef: "lobu:shifu-u-abc123",
		});

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const initialControl = await sql`
			SELECT c.management_mode, c.configuration_revision::text AS configuration_revision,
			       command_row.mutation_kind, command_row.resulting_revision::text AS resulting_revision
			FROM agent_configuration_controls c
			JOIN agent_configuration_commands command_row
			  ON command_row.organization_id = c.organization_id
			 AND command_row.agent_id = c.agent_id
			WHERE c.organization_id = ${ORG_ID}
			  AND c.agent_id = ${"shifu-u-abc123"}
		`;
		expect(initialControl).toEqual([{
			management_mode: "native",
			configuration_revision: "1",
			mutation_kind: "bootstrap",
			resulting_revision: "1",
		}]);
		const grants = await sql`
			SELECT kind, pattern, denied
			FROM grants
			WHERE organization_id = ${ORG_ID}
			  AND agent_id = ${"shifu-u-abc123"}
			ORDER BY kind, pattern
		`;
		expect(grants).toEqual([
			{ kind: "domain", pattern: "*", denied: false },
			{
				kind: "mcp_tool",
				pattern: "/mcp/lobu-memory/tools/*",
				denied: false,
			},
		]);

		const second = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-abc123",
				name: "Updated Agent",
				settings: { userMd: "Updated onboarding copy." },
			}),
		});

		expect(second.status).toBe(200);
		await expect(second.json()).resolves.toMatchObject({
			ok: true,
			agentId: "shifu-u-abc123",
			created: false,
		});

		const { createPostgresAgentConfigStore } = await import(
			"../stores/postgres-stores.js"
		);
		const store = createPostgresAgentConfigStore();
		const metadata = await orgContext.run({ organizationId: ORG_ID }, () =>
			store.getMetadata("shifu-u-abc123"),
		);
		const settings = await orgContext.run({ organizationId: ORG_ID }, () =>
			store.getSettings("shifu-u-abc123"),
		);

		expect(metadata).toMatchObject({
			agentId: "shifu-u-abc123",
			name: "Updated Agent",
			owner: { platform: "toolbox", userId: "gateway-user" },
			organizationId: ORG_ID,
		});
		expect(settings).toMatchObject({
			userMd: "Updated onboarding copy.",
		});
	});

	test("saves provided Toolbox owner user id instead of PAT user id", async () => {
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-owner-override",
				name: "Toolbox Owner Agent",
				ownerUserId: "  toolbox-user-20a9e88f  ",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			agentId: "shifu-u-owner-override",
			created: true,
			membership: { ensured: true, role: "member" },
			revisionRef: "lobu:shifu-u-owner-override",
		});

		const { createPostgresAgentConfigStore } = await import(
			"../stores/postgres-stores.js"
		);
		const store = createPostgresAgentConfigStore();
		const metadata = await orgContext.run({ organizationId: ORG_ID }, () =>
			store.getMetadata("shifu-u-owner-override"),
		);

		expect(metadata).toMatchObject({
			agentId: "shifu-u-owner-override",
			owner: { platform: "toolbox", userId: "toolbox-user-20a9e88f" },
			organizationId: ORG_ID,
		});
	});

	test("syncs agent_users for Toolbox owner and Gateway PAT owner", async () => {
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-agent-users",
				name: "Agent Users Ready Agent",
				ownerUserId: "toolbox-user-agent-users",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);

		const { getDb } = await import("../../db/client.js");
		const rows = await getDb()`
			SELECT organization_id, agent_id, platform, user_id
			FROM agent_users
			WHERE organization_id = ${ORG_ID}
			  AND agent_id = ${"shifu-u-agent-users"}
			ORDER BY platform, user_id
		`;

		expect(rows).toEqual([
			{
				organization_id: ORG_ID,
				agent_id: "shifu-u-agent-users",
				platform: "external",
				user_id: "gateway-user",
			},
			{
				organization_id: ORG_ID,
				agent_id: "shifu-u-agent-users",
				platform: "toolbox",
				user_id: "toolbox-user-agent-users",
			},
		]);

		const { UserAgentsStore } = await import("../../gateway/auth/user-agents-store.js");
		const store = new UserAgentsStore();
		await expect(
			store.ownsAgent("external", "gateway-user", "shifu-u-agent-users", ORG_ID),
		).resolves.toBe(true);
	});

	test("repeated provisioning keeps one current Toolbox owner row", async () => {
		const app = await buildApp();

		for (const ownerUserId of [
			"toolbox-user-old",
			"toolbox-user-new",
			"toolbox-user-new",
		]) {
			const response = await app.request("/api/provisioning/agents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentId: "shifu-u-owner-reassign",
					name: "Owner Reassignment Agent",
					ownerUserId,
					settings: {},
				}),
			});

			expect([200, 201]).toContain(response.status);
		}

		const { getDb } = await import("../../db/client.js");
		const rows = await getDb()`
			SELECT platform, user_id, COUNT(*)::int AS count
			FROM agent_users
			WHERE organization_id = ${ORG_ID}
			  AND agent_id = ${"shifu-u-owner-reassign"}
			GROUP BY platform, user_id
			ORDER BY platform, user_id
		`;

		expect(rows).toEqual([
			{ platform: "external", user_id: "gateway-user", count: 1 },
			{ platform: "toolbox", user_id: "toolbox-user-new", count: 1 },
		]);
	});

	test("ensures provided Toolbox owner is a member of the PAT organization", async () => {
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-member-owner",
				name: "Toolbox Owner Member Agent",
				ownerUserId: "toolbox-user-member-1",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const members = await sql`
			SELECT "organizationId", "userId", role
			FROM "member"
			WHERE "organizationId" = ${ORG_ID}
			  AND "userId" = ${"toolbox-user-member-1"}
		`;

		expect(members).toEqual([
			{
				organizationId: ORG_ID,
				userId: "toolbox-user-member-1",
				role: "member",
			},
		]);
	});

	test("repeated provisioning creates one member row for the Toolbox owner", async () => {
		const app = await buildApp();

		for (const name of ["Idempotent Member Agent", "Updated Member Agent"]) {
			const response = await app.request("/api/provisioning/agents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentId: "shifu-u-idempotent-member",
					name,
					ownerUserId: "toolbox-user-idempotent",
					settings: {},
				}),
			});

			expect([200, 201]).toContain(response.status);
		}

		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const members = await sql<{ count: string }[]>`
			SELECT COUNT(*)::text AS count
			FROM "member"
			WHERE "organizationId" = ${ORG_ID}
			  AND "userId" = ${"toolbox-user-idempotent"}
		`;

		expect(members).toEqual([{ count: "1" }]);
	});

	test("preserves an existing Toolbox owner admin role during provisioning", async () => {
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		await sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (
				'toolbox-user-admin',
				'Toolbox Admin User',
				'toolbox-user-admin@example.test',
				true,
				NOW(),
				NOW()
			)
		`;
		await sql`
			INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
			VALUES (
				'member_existing_admin',
				${ORG_ID},
				'toolbox-user-admin',
				'admin',
				NOW()
			)
		`;
		const app = await buildApp();

		const request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-admin-owner",
				name: "Admin Owner Agent",
				ownerUserId: "toolbox-user-admin",
				settings: {},
			}),
		};
		const response = await app.request("/api/provisioning/agents", request);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toMatchObject({
			membership: { ensured: true, role: "admin" },
		});
		const replay = await app.request("/api/provisioning/agents", request);
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({
			membership: { ensured: true, role: "admin" },
		});

		const members = await sql`
			SELECT id, "organizationId", "userId", role
			FROM "member"
			WHERE "organizationId" = ${ORG_ID}
			  AND "userId" = ${"toolbox-user-admin"}
		`;

		expect(members).toEqual([
			{
				id: "member_existing_admin",
				organizationId: ORG_ID,
				userId: "toolbox-user-admin",
				role: "admin",
			},
		]);
	});

	test("maps changed admin PAT effects under the same broad command to a stable 409", async () => {
		const body = {
			agentId: "shifu-u-broad-command-conflict",
			name: "Broad Command Conflict",
			ownerUserId: "toolbox-user-broad-conflict",
			settings: { userMd: "original broad settings" },
		};
		const first = await (await buildApp()).request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(first.status).toBe(201);

		const conflict = await (
			await buildApp(["mcp:admin"], { authUserId: "changed-gateway-user" })
		).request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(conflict.status).toBe(409);
		await expect(conflict.json()).resolves.toEqual({
			error: "agent_configuration_command_conflict",
			currentRevision: "1",
		});

		const { getDb } = await import("../../db/client.js");
		const owners = await getDb()`
			SELECT platform, user_id FROM agent_users
			WHERE organization_id = ${ORG_ID}
			  AND agent_id = ${body.agentId}
			ORDER BY platform, user_id
		`;
		expect(owners).toEqual([
			{ platform: "external", user_id: "gateway-user" },
			{ platform: "toolbox", user_id: body.ownerUserId },
		]);
	});

	test("maps a broad bootstrap revision conflict to a stable 409", async () => {
		const { AgentConfigurationError } = await import("../agent-configuration/index.js");
		const app = await buildApp(["mcp:admin"], {
			agentConfigurationAuthority: {
				bootstrap: async () => {
					throw new AgentConfigurationError(
						"agent_configuration_revision_mismatch",
						"7",
					);
				},
			},
		});
		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-broad-revision-conflict",
				name: "Broad Revision Conflict",
				settings: {},
			}),
		});

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "agent_configuration_revision_mismatch",
			currentRevision: "7",
		});
	});

	test("uses a hash-based placeholder email so old raw-email collisions do not block provisioning", async () => {
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		await sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (
				'existing-email-user',
				'Existing Email User',
				'toolbox-user-email-collision@toolbox.local',
				true,
				NOW(),
				NOW()
			)
		`;
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-email-collision",
				name: "Email Collision Agent",
				ownerUserId: "toolbox-user-email-collision",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);

		const members = await sql`
			SELECT "organizationId", "userId", role
			FROM "member"
			WHERE "organizationId" = ${ORG_ID}
			  AND "userId" = ${"toolbox-user-email-collision"}
		`;
		expect(members).toEqual([
			{
				organizationId: ORG_ID,
				userId: "toolbox-user-email-collision",
				role: "member",
			},
		]);
		const users = await sql<{ email: string }[]>`
			SELECT email
			FROM "user"
			WHERE id = ${"toolbox-user-email-collision"}
		`;
		expect(users[0]?.email).toMatch(
			/^toolbox-owner-[a-f0-9]{32}@toolbox\.local$/,
		);
		expect(users[0]?.email).not.toBe(
			"toolbox-user-email-collision@toolbox.local",
		);
	});

	test("does not persist agent metadata when owner membership cannot be ensured", async () => {
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		const ownerUserId = "toolbox-user-membership-fails";
		const collidingMemberId = deterministicMembershipId(ORG_ID, ownerUserId);
		await seedOrg("org-membership-collision");
		await sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
			VALUES (
				'existing-collision-member-user',
				'Existing Collision Member User',
				'existing-collision-member-user@example.test',
				true,
				NOW(),
				NOW()
			)
		`;
		await sql`
			INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
			VALUES (
				${collidingMemberId},
				'org-membership-collision',
				'existing-collision-member-user',
				'member',
				NOW()
			)
		`;
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-membership-failure",
				name: "Membership Failure Agent",
				ownerUserId,
				settings: {},
			}),
		});

		expect(response.status).toBe(500);

		const { createPostgresAgentConfigStore } = await import(
			"../stores/postgres-stores.js"
		);
		const store = createPostgresAgentConfigStore();
		const metadata = await orgContext.run({ organizationId: ORG_ID }, () =>
			store.getMetadata("shifu-u-membership-failure"),
		);
		expect(metadata).toBeNull();
	});

	test("provisioned Toolbox owner can immediately satisfy memory-route membership", async () => {
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-memory-member",
				name: "Memory Ready Agent",
				ownerUserId: "toolbox-user-memory-ready",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);

		const { getWorkspaceRole } = await import(
			"../../utils/organization-access.js"
		);
		const { getDb } = await import("../../db/client.js");
		await expect(
			getWorkspaceRole(getDb(), ORG_ID, "toolbox-user-memory-ready"),
		).resolves.toBe("member");
	});

	test("newly provisioned Toolbox owner can write a durable context pack through the memory service", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-context-pack-owner";
		const ownerUserId = "toolbox-user-context-pack";

		const provision = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId,
				name: "Context Pack Owner Agent",
				ownerUserId,
				settings: {},
			}),
		});
		expect(provision.status).toBe(201);

		const { getDb } = await import("../../db/client.js");
		const { getWorkspaceRole } = await import(
			"../../utils/organization-access.js"
		);
		const ownerMemberRole = await getWorkspaceRole(
			getDb(),
			ORG_ID,
			ownerUserId,
		);
		expect(ownerMemberRole).toBe("member");

		const { writeContextPackMemory } = await import(
			"../context-pack-memory-service.js"
		);
		const body = await orgContext.run({ organizationId: ORG_ID }, () =>
			writeContextPackMemory({
				organizationId: ORG_ID,
				ownerMemberRole: ownerMemberRole!,
				authSource: "pat",
				scopes: ["mcp:admin"],
				body: contextPackBody(agentId, ownerUserId),
			}),
		);

		const eventId = body.eventId;
		expect(Number.isInteger(eventId)).toBe(true);
		expect(body).toMatchObject({
			refs: [expect.stringMatching(/^lobu:event:\d+$/)],
			eventId,
			semanticType: "project_profile",
			agentId,
		});

		const sql = getDb();
		const events = await sql`
			SELECT id, organization_id, semantic_type, created_by, metadata
			FROM events
			WHERE id = ${eventId}
		`;
		expect(events).toEqual([
			expect.objectContaining({
				id: eventId,
				organization_id: ORG_ID,
				semantic_type: "project_profile",
				created_by: ownerUserId,
				metadata: expect.objectContaining({
					source: "toolbox_onboarding",
					owner_user_id: ownerUserId,
					agent_id: agentId,
					memory_source: "toolbox_onboarding",
				}),
			}),
		]);
	});

	test("rejects blank Toolbox owner user id overrides", async () => {
		const app = await buildApp();

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-blank-owner",
				name: "Blank Owner Agent",
				ownerUserId: "   ",
				settings: {},
			}),
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "ownerUserId must be a non-empty string when provided",
		});
	});

	test("rejects PATs without mcp:admin scope", async () => {
		const app = await buildApp(["mcp:read", "mcp:write"]);
		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-abc123",
				name: "PM / Marketing Agent",
				settings: {},
			}),
		});

		expect(response.status).toBe(403);
	});

	test("rejects non-ShiFu agent ids", async () => {
		const app = await buildApp();
		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "lobu-test",
				name: "Wrong Agent",
				settings: {},
			}),
		});

		expect(response.status).toBe(400);
	});
});

describe("PUT /api/provisioning/agents/:agentId/fenced-settings", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("creates once and makes an exact retry idempotent", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-fenced-create";
		const body = fencedProvisioningBody();

		const first = await putFencedAgent(app, agentId, body);
		expect(first.status).toBe(201);
		await expect(first.json()).resolves.toEqual({
			ok: true,
			agentId,
			created: true,
			membership: { ensured: true, role: "member" },
			revisionRef: `lobu:${agentId}`,
			provisioningFence: {
				targetId: FENCE_TARGET_ID,
				claimGeneration: 1,
				claimToken: FENCE_TOKEN_A,
				baselineVersionId: BASELINE_VERSION_ID,
				effectiveSettingsDigest: EFFECTIVE_SETTINGS_DIGEST,
			},
		});

		const replay = await putFencedAgent(app, agentId, {
			...body,
			settings: { userMd: "generation one" },
		});
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({
			ok: true,
			agentId,
			created: false,
			provisioningFence: { claimGeneration: 1, claimToken: FENCE_TOKEN_A },
		});
		const rows = await (await import("../../db/client.js")).getDb()`
			SELECT c.configuration_revision::text AS configuration_revision,
			       count(command_row.command_id)::int AS command_count
			FROM agent_configuration_controls c
			JOIN agent_configuration_commands command_row
			  ON command_row.organization_id = c.organization_id
			 AND command_row.agent_id = c.agent_id
			WHERE c.organization_id = ${ORG_ID} AND c.agent_id = ${agentId}
			GROUP BY c.configuration_revision
		`;
		expect(rows).toEqual([{ configuration_revision: "1", command_count: 1 }]);
	});

	test("maps changed admin PAT effects under the same fenced command to a stable 409", async () => {
		const agentId = "shifu-u-fenced-command-conflict";
		const body = fencedProvisioningBody();
		const first = await putFencedAgent(await buildApp(), agentId, body);
		expect(first.status).toBe(201);

		const conflict = await putFencedAgent(
			await buildApp(["mcp:admin"], { authUserId: "changed-gateway-user" }),
			agentId,
			body,
		);
		expect(conflict.status).toBe(409);
		await expect(conflict.json()).resolves.toEqual({
			error: "agent_configuration_command_conflict",
			currentRevision: "1",
		});

		const { getDb } = await import("../../db/client.js");
		const owners = await getDb()`
			SELECT platform, user_id FROM agent_users
			WHERE organization_id = ${ORG_ID} AND agent_id = ${agentId}
			ORDER BY platform, user_id
		`;
		expect(owners).toEqual([
			{ platform: "external", user_id: "gateway-user" },
			{ platform: "toolbox", user_id: body.ownerUserId },
		]);
	});

	test("maps a fenced bootstrap revision conflict to a stable 409", async () => {
		const { AgentConfigurationError } = await import("../agent-configuration/index.js");
		const app = await buildApp(["mcp:admin"], {
			agentConfigurationAuthority: {
				bootstrap: async () => {
					throw new AgentConfigurationError(
						"agent_configuration_revision_mismatch",
						"9",
					);
				},
			},
		});
		const response = await putFencedAgent(
			app,
			"shifu-u-fenced-revision-conflict",
			fencedProvisioningBody(),
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "agent_configuration_revision_mismatch",
			currentRevision: "9",
		});
	});

	test("rolls back the whole aggregate when final authority control persistence fails", async () => {
		const sql = (await import("../../db/client.js")).getDb();
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION fail_bootstrap_control_update_for_test()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				RAISE EXCEPTION 'injected bootstrap control failure';
			END;
			$$
		`);
		await sql.unsafe(`
			CREATE TRIGGER fail_bootstrap_control_update_for_test
			BEFORE UPDATE ON agent_configuration_controls
			FOR EACH ROW EXECUTE FUNCTION fail_bootstrap_control_update_for_test()
		`);
		try {
			const response = await putFencedAgent(
				await buildApp(),
				"shifu-u-bootstrap-rollback",
				fencedProvisioningBody({
					settings: {
						userMd: "must roll back",
						preApprovedTools: ["/mcp/notion/tools/*"],
					},
				}),
			);
			expect(response.status).toBe(500);
		} finally {
			await sql.unsafe(`
				DROP TRIGGER IF EXISTS fail_bootstrap_control_update_for_test
				ON agent_configuration_controls
			`);
			await sql.unsafe(`DROP FUNCTION IF EXISTS fail_bootstrap_control_update_for_test()`);
		}

		const aggregate = await sql`
			SELECT
			  (SELECT count(*)::int FROM agents
			   WHERE organization_id = ${ORG_ID} AND id = 'shifu-u-bootstrap-rollback') AS agents,
			  (SELECT count(*)::int FROM agent_configuration_controls
			   WHERE organization_id = ${ORG_ID} AND agent_id = 'shifu-u-bootstrap-rollback') AS controls,
			  (SELECT count(*)::int FROM agent_configuration_commands
			   WHERE organization_id = ${ORG_ID} AND agent_id = 'shifu-u-bootstrap-rollback') AS commands,
			  (SELECT count(*)::int FROM agent_provisioning_fences
			   WHERE organization_id = ${ORG_ID} AND agent_id = 'shifu-u-bootstrap-rollback') AS fences,
			  (SELECT count(*)::int FROM grants
			   WHERE organization_id = ${ORG_ID} AND agent_id = 'shifu-u-bootstrap-rollback') AS grants,
			  (SELECT count(*)::int FROM agent_users
			   WHERE organization_id = ${ORG_ID} AND agent_id = 'shifu-u-bootstrap-rollback') AS owners,
			  (SELECT count(*)::int FROM "member"
			   WHERE "organizationId" = ${ORG_ID} AND "userId" = 'toolbox-user-fenced') AS members,
			  (SELECT count(*)::int FROM "user" WHERE id = 'toolbox-user-fenced') AS users
		`;
		expect(aggregate).toEqual([{
			agents: 0,
			controls: 0,
			commands: 0,
			fences: 0,
			grants: 0,
			owners: 0,
			members: 0,
			users: 0,
		}]);
	});

	test("rejects same-generation conflicts without changing observable settings", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-fenced-conflict";
		const retainedGrant = "/mcp/google_workspace/tools/gws_docs_read";
		const rejectedGrant = "/mcp/shifu-toolbox/tools/get_project_profile";
		expect(
			(
				await putFencedAgent(
					app,
					agentId,
					fencedProvisioningBody({
						settings: {
							userMd: "generation one",
							preApprovedTools: ["/mcp/google_workspace/tools/*"],
						},
					}),
				)
			).status,
		).toBe(201);

		const conflict = await putFencedAgent(
			app,
			agentId,
			fencedProvisioningBody({
				settings: {
					userMd: "must not win",
					preApprovedTools: ["/mcp/shifu-toolbox/tools/*"],
				},
			}),
		);
		expect(conflict.status).toBe(409);
		await expect(conflict.json()).resolves.toEqual({
			error: "provisioning_fence_conflict",
		});
		const tokenConflict = await putFencedAgent(app, agentId, {
			...fencedProvisioningBody(),
			claimToken: FENCE_TOKEN_B,
		});
		expect(tokenConflict.status).toBe(409);
		await expect(tokenConflict.json()).resolves.toEqual({
			error: "provisioning_fence_conflict",
		});

		const settings = await app.request(
			`/api/provisioning/agents/${agentId}/settings`,
		);
		expect(settings.status).toBe(200);
		await expect(settings.json()).resolves.toMatchObject({
			settings: { userMd: "generation one" },
		});
		for (const [pattern, ok] of [
			[retainedGrant, true],
			[rejectedGrant, false],
		] as const) {
			const verification = await app.request(
				`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						revisionId: "same-generation-conflict",
						expectedGrantPatterns: [pattern],
					}),
				},
			);
			await expect(verification.json()).resolves.toMatchObject({ ok });
		}
	});

	test("lets a newer generation take over and rejects the late old owner", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-fenced-takeover";
		const retiredGrant = "/mcp/google_workspace/tools/gws_docs_read";
		const winningGrant = "/mcp/shifu-toolbox/tools/get_project_profile";
		const generationOne = fencedProvisioningBody({
			settings: {
				userMd: "generation one",
				networkConfig: { allowedDomains: ["*"] },
				preApprovedTools: ["/mcp/google_workspace/tools/*"],
			},
		});
		expect(
			(await putFencedAgent(app, agentId, generationOne)).status,
		).toBe(201);
		const beforeTakeover = await app.request(
			`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					revisionId: "generation-one",
					expectedGrantPatterns: [retiredGrant],
				}),
			},
		);
		await expect(beforeTakeover.json()).resolves.toMatchObject({ ok: true });

		const takeover = await putFencedAgent(
			app,
			agentId,
			fencedProvisioningBody({
				claimGeneration: 2,
				claimToken: FENCE_TOKEN_B,
				settings: {
					userMd: "generation two",
					preApprovedTools: ["/mcp/shifu-toolbox/tools/*"],
				},
			}),
		);
		expect(takeover.status).toBe(200);
		await expect(takeover.json()).resolves.toMatchObject({
			provisioningFence: { claimGeneration: 2, claimToken: FENCE_TOKEN_B },
		});
		const control = await (await import("../../db/client.js")).getDb()`
			SELECT c.configuration_revision::text AS configuration_revision,
			       count(command_row.command_id)::int AS command_count
			FROM agent_configuration_controls c
			JOIN agent_configuration_commands command_row
			  ON command_row.organization_id = c.organization_id
			 AND command_row.agent_id = c.agent_id
			WHERE c.organization_id = ${ORG_ID} AND c.agent_id = ${agentId}
			GROUP BY c.configuration_revision
		`;
		expect(control).toEqual([{ configuration_revision: "2", command_count: 2 }]);

		const late = await putFencedAgent(app, agentId, generationOne);
		expect(late.status).toBe(409);
		await expect(late.json()).resolves.toEqual({
			error: "provisioning_fence_stale",
		});
		const settings = await app.request(
			`/api/provisioning/agents/${agentId}/settings`,
		);
		await expect(settings.json()).resolves.toMatchObject({
			settings: { userMd: "generation two" },
		});
		const afterTakeover = await app.request(
			`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					revisionId: "generation-two",
					expectedGrantPatterns: [retiredGrant],
				}),
			},
		);
		await expect(afterTakeover.json()).resolves.toMatchObject({
			ok: false,
			errorCode: "runtime_grants_missing",
			missingGrantPatterns: [retiredGrant],
		});
		const winningGrantCheck = await app.request(
			`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					revisionId: "generation-two-winning-grant",
					expectedGrantPatterns: [winningGrant],
				}),
			},
		);
		await expect(winningGrantCheck.json()).resolves.toMatchObject({ ok: true });
	});

	test("rejects a delayed legacy provisioning write after fenced generation wins", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-fenced-legacy-late";
		const winningGrant = "/mcp/shifu-toolbox/tools/get_project_profile";
		const rejectedGrant = "/mcp/google_workspace/tools/gws_docs_read";
		const generationTwo = fencedProvisioningBody({
			claimGeneration: 2,
			claimToken: FENCE_TOKEN_B,
			settings: {
				userMd: "generation two wins",
				preApprovedTools: ["/mcp/shifu-toolbox/tools/*"],
			},
		});

		expect((await putFencedAgent(app, agentId, generationTwo)).status).toBe(201);

		const delayedLegacy = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId,
				name: "Delayed legacy agent",
				ownerUserId: "toolbox-user-legacy",
				settings: {
					userMd: "legacy must not win",
					preApprovedTools: ["/mcp/google_workspace/tools/*"],
				},
			}),
		});
		expect(delayedLegacy.status).toBe(409);
		await expect(delayedLegacy.json()).resolves.toEqual({
			error: "agent_settings_managed_by_fenced_provisioning",
		});

		const settings = await app.request(
			`/api/provisioning/agents/${agentId}/settings`,
		);
		await expect(settings.json()).resolves.toMatchObject({
			settings: { userMd: "generation two wins" },
		});
		for (const [pattern, ok] of [
			[winningGrant, true],
			[rejectedGrant, false],
		] as const) {
			const verification = await app.request(
				`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						revisionId: "legacy-after-fenced-generation",
						expectedGrantPatterns: [pattern],
					}),
				},
			);
			await expect(verification.json()).resolves.toMatchObject({ ok });
		}

		const exactReplay = await putFencedAgent(app, agentId, generationTwo);
		expect(exactReplay.status).toBe(200);
		await expect(exactReplay.json()).resolves.toMatchObject({
			provisioningFence: { claimGeneration: 2, claimToken: FENCE_TOKEN_B },
		});
	});

	test("serializes concurrent requests from separate app replicas so the highest generation wins", async () => {
		const replicaA = await buildApp();
		const replicaB = await buildApp();
		const agentId = "shifu-u-fenced-replicas";

		const [oldOwner, newOwner] = await Promise.all([
			putFencedAgent(replicaA, agentId, fencedProvisioningBody()),
			putFencedAgent(
				replicaB,
				agentId,
				fencedProvisioningBody({
					claimGeneration: 2,
					claimToken: FENCE_TOKEN_B,
					settings: { userMd: "generation two" },
				}),
			),
		]);
		expect([200, 201, 409]).toContain(oldOwner.status);
		expect([200, 201]).toContain(newOwner.status);

		const settings = await replicaA.request(
			`/api/provisioning/agents/${agentId}/settings`,
		);
		await expect(settings.json()).resolves.toMatchObject({
			settings: { userMd: "generation two" },
		});
	});

	test("does not revoke a pre-existing grant that fenced provisioning does not own", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-fenced-unrelated-grant";
		const unrelatedGrant = "/mcp/notion/tools/notion_search";
		const legacy = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId,
				name: "Existing agent",
				ownerUserId: "toolbox-user-fenced",
				settings: { preApprovedTools: ["/mcp/notion/tools/*"] },
			}),
		});
		expect(legacy.status).toBe(201);

		const fenced = await putFencedAgent(
			app,
			agentId,
			fencedProvisioningBody({
				settings: { userMd: "authoritative fenced settings" },
			}),
		);
		expect(fenced.status).toBe(200);

		const verification = await app.request(
			`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					revisionId: "unrelated-grant",
					expectedGrantPatterns: [unrelatedGrant],
				}),
			},
		);
		await expect(verification.json()).resolves.toMatchObject({ ok: true });
	});

	for (const existingState of ["denied", "expired"] as const) {
		test(`reactivates an unowned ${existingState} desired grant without later claiming or deleting it`, async () => {
			const app = await buildApp();
			const agentId = `shifu-u-fenced-${existingState}-grant`;
			const wildcard = "/mcp/notion/tools/*";
			const expectedTool = "/mcp/notion/tools/notion_search";
			const legacy = await app.request("/api/provisioning/agents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentId,
					name: "Existing agent",
					ownerUserId: "toolbox-user-fenced",
					settings: { preApprovedTools: [wildcard] },
				}),
			});
			expect(legacy.status).toBe(201);

			const { GrantStore } = await import(
				"../../gateway/permissions/grant-store.js"
			);
			await new GrantStore().grant(
				agentId,
				wildcard,
				existingState === "expired" ? Date.now() - 1_000 : null,
				existingState === "denied",
				ORG_ID,
			);

			const verify = (revisionId: string) =>
				app.request(
					`/api/provisioning/agents/${agentId}/runtime-grants/verify`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							revisionId,
							expectedGrantPatterns: [expectedTool],
						}),
					},
				);
			await expect((await verify("before-fenced-apply")).json()).resolves.toMatchObject({
				ok: false,
				errorCode: "runtime_grants_missing",
			});

			const apply = await putFencedAgent(
				app,
				agentId,
				fencedProvisioningBody({
					settings: { preApprovedTools: [wildcard] },
				}),
			);
			expect(apply.status).toBe(200);
			await expect((await verify("after-fenced-apply")).json()).resolves.toMatchObject({
				ok: true,
			});

			const removeFromBaseline = await putFencedAgent(
				app,
				agentId,
				fencedProvisioningBody({
					claimGeneration: 2,
					claimToken: FENCE_TOKEN_B,
					settings: { userMd: "no fenced grants" },
				}),
			);
			expect(removeFromBaseline.status).toBe(200);
			await expect(
				(await verify("after-fenced-removal")).json(),
			).resolves.toMatchObject({ ok: true });
		});
	}

	test("rejects malformed and unbounded fence fields before creating an agent", async () => {
		const app = await buildApp();
		const invalidBodies = [
			(() => {
				const { settings: _settings, ...withoutSettings } = fencedProvisioningBody();
				return withoutSettings;
			})(),
			{ ...fencedProvisioningBody(), targetId: "not-a-uuid" },
			{ ...fencedProvisioningBody(), claimGeneration: 0 },
			{
				...fencedProvisioningBody(),
				claimGeneration: Number.MAX_SAFE_INTEGER + 1,
			},
			{
				...fencedProvisioningBody(),
				claimToken: "secret-like-unbounded".repeat(20),
			},
			{ ...fencedProvisioningBody(), baselineVersionId: "draft" },
			{ ...fencedProvisioningBody(), effectiveSettingsDigest: "sha256:nope" },
			{ ...fencedProvisioningBody(), name: "x".repeat(201) },
			{ ...fencedProvisioningBody(), settings: { guardrails: "not-an-array" } },
		];

		for (const [index, body] of invalidBodies.entries()) {
			const response = await putFencedAgent(
				app,
				`shifu-u-invalid-fence-${index}`,
				body,
			);
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error?: unknown };
			expect(typeof payload.error).toBe("string");
			expect(JSON.stringify(payload).length).toBeLessThan(300);
		}
	});
});

describe("GET /api/provisioning/agents/:agentId/settings", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("returns live settings for a provisioned ShiFu user agent", async () => {
		const app = await buildApp();
		const agentId = "shifu-u-settings-read";

		const provision = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId,
				name: "Settings Read Agent",
				settings: {
					identityMd: "You are ShiFu.",
					mcpServers: {
						"shifu-toolbox": {
							type: "streamable-http",
							url: "https://mcp.shifu-ai.org/mcp",
						},
					},
					preApprovedTools: ["/mcp/shifu-toolbox/tools/*"],
				},
			}),
		});
		expect(provision.status).toBe(201);

		const response = await app.request(
			`/api/provisioning/agents/${agentId}/settings`,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			agentId,
			settings: {
				identityMd: "You are ShiFu.",
				mcpServers: {
					"shifu-toolbox": {
						type: "streamable-http",
						url: "https://mcp.shifu-ai.org/mcp",
					},
				},
				preApprovedTools: ["/mcp/shifu-toolbox/tools/*"],
			},
		});
	});

	test("rejects settings reads for PATs without mcp:admin scope", async () => {
		const app = await buildApp(["mcp:read"]);

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-settings-no-admin/settings",
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: "forbidden",
		});
	});

	test("rejects invalid agent ids", async () => {
		const app = await buildApp();

		const response = await app.request(
			"/api/provisioning/agents/lobu-test/settings",
		);

		expect(response.status).toBe(400);
	});

	test("returns 404 for a valid ShiFu user agent without settings", async () => {
		const app = await buildApp();

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-missing-settings/settings",
		);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: "Agent not found",
		});
	});
});

describe("POST /api/provisioning/agents/:agentId/runtime-grants/verify", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("verifies expected MCP grant patterns against the Lobu runtime grant store", async () => {
		const app = await buildApp();

		const provision = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-grant-verify",
				name: "Grant Verify Agent",
				ownerUserId: "toolbox-user-1",
				settings: {
					preApprovedTools: ["/mcp/google_workspace/tools/gws_docs_read"],
				},
			}),
		});
		expect(provision.status).toBe(201);

		const verified = await app.request(
			"/api/provisioning/agents/shifu-u-grant-verify/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "toolbox-user-1",
					revisionId: "mcp_revision_test",
					expectedGrantPatterns: ["/mcp/google_workspace/tools/gws_docs_read"],
				}),
			},
		);

		expect(verified.status).toBe(200);
		await expect(verified.json()).resolves.toMatchObject({
			ok: true,
			sidecarRevisionRef: "lobu:shifu-u-grant-verify:mcp_revision_test",
			runtime: {
				agentId: "shifu-u-grant-verify",
				grantChecks: [
					{
						pattern: "/mcp/google_workspace/tools/gws_docs_read",
						kind: "mcp_tool",
						present: true,
						matchedPattern: "/mcp/google_workspace/tools/gws_docs_read",
					},
				],
			},
		});
	});

	test("verifies expected MCP grant patterns through wildcard runtime grants", async () => {
		const app = await buildApp();

		const provision = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-wildcard-grant",
				name: "Wildcard Grant Agent",
				ownerUserId: "toolbox-user-1",
				settings: {
					preApprovedTools: ["/mcp/google_workspace/tools/*"],
				},
			}),
		});
		expect(provision.status).toBe(201);

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-wildcard-grant/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "toolbox-user-1",
					revisionId: "mcp_revision_wildcard",
					expectedGrantPatterns: [
						"/mcp/google_workspace/tools/gws_calendar_events_list",
					],
				}),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			sidecarRevisionRef: "lobu:shifu-u-wildcard-grant:mcp_revision_wildcard",
			runtime: {
				agentId: "shifu-u-wildcard-grant",
				grantChecks: [
					{
						pattern: "/mcp/google_workspace/tools/gws_calendar_events_list",
						kind: "mcp_tool",
						present: true,
						matchedPattern: "/mcp/google_workspace/tools/*",
					},
				],
			},
		});
	});

	test("returns runtime_grants_missing when expected tool grants are absent", async () => {
		const app = await buildApp();
		const provision = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-missing-grant",
				name: "Missing Grant Agent",
				ownerUserId: "toolbox-user-1",
				settings: { preApprovedTools: [] },
			}),
		});
		expect(provision.status).toBe(201);

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-missing-grant/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "toolbox-user-1",
					revisionId: "mcp_revision_missing",
					expectedGrantPatterns: ["/mcp/google_workspace/tools/gws_docs_read"],
				}),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			errorCode: "runtime_grants_missing",
			userVisibleSummary:
				"Lobu runtime has not applied the expected MCP tool grants yet.",
			missingGrantPatterns: ["/mcp/google_workspace/tools/gws_docs_read"],
		});
	});

	test("rejects invalid expected MCP grant patterns", async () => {
		const app = await buildApp();

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-invalid-patterns/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedGrantPatterns: ["google_workspace.gws_docs_read"],
				}),
			},
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			errorCode: "invalid_expected_grant_patterns",
		});
	});

	test("rejects runtime grant verification for a mismatched Toolbox owner", async () => {
		const app = await buildApp();
		await seedPersonalAgent("shifu-u-owner-check", "toolbox-user-owner");

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-owner-check/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "toolbox-user-other",
					expectedGrantPatterns: ["/mcp/google_workspace/tools/*"],
				}),
			},
		);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_owner_mismatch",
		});
	});

	test("rejects runtime grant verification for PATs without mcp:admin", async () => {
		const app = await buildApp(["mcp:read"]);
		const response = await app.request(
			"/api/provisioning/agents/shifu-u-no-admin/runtime-grants/verify",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedGrantPatterns: ["/mcp/google_workspace/tools/*"],
				}),
			},
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: "forbidden",
		});
	});
});

describe("POST /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/start", () => {
	beforeEach(async () => {
		startAuthCodeFlowMock.mockClear();
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("starts a browser OAuth flow for a shifu personal agent MCP", async () => {
		await seedPersonalAgent();
		const secretStore = createMemorySecretStore();
		const app = await buildApp(["mcp:admin"], {
			secretStore,
			mcpConfigService: {
				async getHttpServer(mcpId: string, agentId?: string) {
					expect(mcpId).toBe("shifu-toolbox");
					expect(agentId).toBe("shifu-u-abc123");
					return {
						id: "shifu-toolbox",
						upstreamUrl: "https://mcp.shifu-ai.org/mcp",
						oauth: {
							resource: "https://mcp.shifu-ai.org/mcp",
							scopes: ["mcp:read", "mcp:write", "profile:read"],
						},
					};
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/start",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userId: "toolbox-user-1" }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			mcpId: "shifu-toolbox",
			authorizationUrl: "https://auth.example.test/authorize?state=test-state",
		});
		expect(startAuthCodeFlowMock).toHaveBeenCalledTimes(1);
		expect(startAuthCodeFlowMock.mock.calls[0]?.[0]).toMatchObject({
			secretStore,
			mcpId: "shifu-toolbox",
			upstreamUrl: "https://mcp.shifu-ai.org/mcp",
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			scopeKey: "toolbox-user-1",
			redirectUri: "https://gateway.example.test/lobu/mcp/oauth/callback",
			staticOauth: {
				resource: "https://mcp.shifu-ai.org/mcp",
				scopes: ["mcp:read", "mcp:write", "profile:read"],
			},
			platform: "toolbox-web",
			channelId: "",
			conversationId: "",
			resumeMode: "none",
			organizationId: ORG_ID,
		});
	});

	test("rejects OAuth start for PATs without mcp:admin scope", async () => {
		const app = await buildApp(["mcp:read"], {
			secretStore: createMemorySecretStore(),
			mcpConfigService: {
				async getHttpServer() {
					return { id: "shifu-toolbox", upstreamUrl: "https://example.test" };
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/start",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userId: "toolbox-user-1" }),
			},
		);

		expect(response.status).toBe(403);
	});

	test("rejects OAuth start for a mismatched Toolbox owner", async () => {
		await seedPersonalAgent("shifu-u-abc123", "another-toolbox-user");
		const app = await buildApp(["mcp:admin"], {
			secretStore: createMemorySecretStore(),
			mcpConfigService: {
				async getHttpServer() {
					return { id: "shifu-toolbox", upstreamUrl: "https://example.test" };
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/start",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userId: "toolbox-user-1" }),
			},
		);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: "agent_owner_mismatch",
		});
	});
});

describe("GET /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/status", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("reports whether the scoped MCP OAuth credential exists without exposing it", async () => {
		await seedPersonalAgent();
		const secretStore = createMemorySecretStore({
			"mcp-auth/shifu-u-abc123/toolbox-user-1/shifu-toolbox/credential":
				JSON.stringify({
					accessToken: "secret-token",
					refreshToken: "secret-refresh",
					expiresAt: 4_102_444_800_000,
					clientId: "client-1",
					tokenUrl: "https://auth.example.test/token",
				}),
		});
		const app = await buildApp(["mcp:admin"], {
			secretStore,
			mcpConfigService: {
				async getHttpServer() {
					return { id: "shifu-toolbox", upstreamUrl: "https://example.test" };
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/status?userId=toolbox-user-1",
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			ok: true,
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			mcpId: "shifu-toolbox",
			authenticated: true,
			expiresAt: 4_102_444_800_000,
		});
		expect(JSON.stringify(body)).not.toContain("secret-token");
	});

	test("reports an expired credential without refresh token as unauthenticated", async () => {
		await seedPersonalAgent();
		const secretStore = createMemorySecretStore({
			"mcp-auth/shifu-u-abc123/toolbox-user-1/shifu-toolbox/credential":
				JSON.stringify({
					accessToken: "expired-secret-token",
					expiresAt: Date.now() - 60_000,
					clientId: "client-1",
					tokenUrl: "https://auth.example.test/token",
				}),
		});
		const app = await buildApp(["mcp:admin"], {
			secretStore,
			mcpConfigService: {
				async getHttpServer() {
					return { id: "shifu-toolbox", upstreamUrl: "https://example.test" };
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/status?userId=toolbox-user-1",
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			mcpId: "shifu-toolbox",
			authenticated: false,
		});
		expect(JSON.stringify(body)).not.toContain("expired-secret-token");
	});

	test("reports an expired credential with an invalid refresh token as unauthenticated", async () => {
		await seedPersonalAgent();
		const fetchMock = mock(async () =>
			new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const secretStore = createMemorySecretStore({
				"mcp-auth/shifu-u-abc123/toolbox-user-1/shifu-toolbox/credential":
					JSON.stringify({
						accessToken: "expired-secret-token",
						refreshToken: "revoked-refresh-token",
						expiresAt: Date.now() - 60_000,
						clientId: "client-1",
						tokenUrl: "https://auth.example.test/token",
					}),
			});
			const app = await buildApp(["mcp:admin"], {
				secretStore,
				mcpConfigService: {
					async getHttpServer() {
						return { id: "shifu-toolbox", upstreamUrl: "https://example.test" };
					},
				},
			});

			const response = await app.request(
				"/api/provisioning/agents/shifu-u-abc123/mcp/shifu-toolbox/oauth/status?userId=toolbox-user-1",
			);

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				ok: true,
				agentId: "shifu-u-abc123",
				userId: "toolbox-user-1",
				mcpId: "shifu-toolbox",
				authenticated: false,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("POST /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/materialize", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("materializes an existing Lobu OAuth credential into an agent connection ref", async () => {
		await seedPersonalAgent();
		const secretStore = createMemorySecretStore({
			"mcp-auth/shifu-u-abc123/toolbox-user-1/google_workspace/credential":
				JSON.stringify({
					accessToken: "secret-token",
					refreshToken: "secret-refresh",
					expiresAt: 4_102_444_800_000,
					clientId: "client-1",
					tokenUrl: "https://auth.example.test/token",
				}),
		});
		const app = await buildApp(["mcp:admin"], {
			secretStore,
			mcpConfigService: {
				async getHttpServer(mcpId: string, agentId?: string) {
					expect(mcpId).toBe("google_workspace");
					expect(agentId).toBe("shifu-u-abc123");
					return {
						id: "google_workspace",
						upstreamUrl: "https://mcp.google.example.test/mcp",
					};
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/google_workspace/oauth/materialize",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					userId: "toolbox-user-1",
					connectorKey: "google_workspace",
				}),
			},
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			mcpId: "google_workspace",
			status: "ready",
		});
		expect(body.lobuConnectionRef).toMatch(/^toolbox-mcp:/);

		const { getDb } = await import("../../db/client.js");
		const rows = await getDb()`
			SELECT id, agent_id, platform, config, metadata, status
			FROM agent_connections
			WHERE id = ${body.lobuConnectionRef}
		`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: body.lobuConnectionRef,
			agent_id: "shifu-u-abc123",
			platform: "google_workspace",
			status: "active",
		});
		expect(rows[0].metadata).toMatchObject({
			ownerUserId: "toolbox-user-1",
			connectorKey: "google_workspace",
			mcpId: "google_workspace",
			source: "toolbox-personal-agent-materialized",
			authSource: "lobu_oauth",
		});
		expect(JSON.stringify(rows[0])).not.toContain("secret-token");
	});

	test("does not create a connection ref when the Lobu OAuth credential is missing", async () => {
		await seedPersonalAgent();
		const app = await buildApp(["mcp:admin"], {
			secretStore: createMemorySecretStore(),
			mcpConfigService: {
				async getHttpServer() {
					return {
						id: "google_workspace",
						upstreamUrl: "https://mcp.google.example.test/mcp",
					};
				},
			},
		});

		const response = await app.request(
			"/api/provisioning/agents/shifu-u-abc123/mcp/google_workspace/oauth/materialize",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userId: "toolbox-user-1" }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			agentId: "shifu-u-abc123",
			userId: "toolbox-user-1",
			mcpId: "google_workspace",
			status: "not_connected",
			lobuConnectionRef: null,
		});
	});

	test("does not create a connection ref when the Lobu OAuth credential cannot refresh", async () => {
		await seedPersonalAgent();
		const fetchMock = mock(async () =>
			new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const secretStore = createMemorySecretStore({
				"mcp-auth/shifu-u-abc123/toolbox-user-1/google_workspace/credential":
					JSON.stringify({
						accessToken: "expired-secret-token",
						refreshToken: "revoked-refresh-token",
						expiresAt: Date.now() - 60_000,
						clientId: "client-1",
						tokenUrl: "https://auth.example.test/token",
					}),
			});
			const app = await buildApp(["mcp:admin"], {
				secretStore,
				mcpConfigService: {
					async getHttpServer() {
						return {
							id: "google_workspace",
							upstreamUrl: "https://mcp.google.example.test/mcp",
						};
					},
				},
			});

			const response = await app.request(
				"/api/provisioning/agents/shifu-u-abc123/mcp/google_workspace/oauth/materialize",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ userId: "toolbox-user-1" }),
				},
			);

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({
				ok: true,
				agentId: "shifu-u-abc123",
				userId: "toolbox-user-1",
				mcpId: "google_workspace",
				status: "needs_reauth",
				lobuConnectionRef: null,
			});

			const { getDb } = await import("../../db/client.js");
			const rows = await getDb()`
				SELECT id
				FROM agent_connections
				WHERE agent_id = ${"shifu-u-abc123"}
			`;
			expect(rows).toHaveLength(0);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
