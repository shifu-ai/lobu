import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context.js";

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

	return {
		createDeviceAuthRoutes: () => new Hono(),
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
	} = {},
) {
	const { createProvisioningRoutes } = await import(
		"../provisioning-routes.js"
	);
	const app = new Hono();
	app.onError((_error, c) => c.json({ error: "internal_error" }, 500));
	app.use("*", async (c, next) => {
		c.set("user", {
			id: "gateway-user",
			name: "Gateway User",
			email: "gateway@example.test",
			emailVerified: true,
		});
		c.set("session", {
			id: "pat:test-client",
			userId: "gateway-user",
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
		}),
	);
	return app;
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

		const response = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "shifu-u-admin-owner",
				name: "Admin Owner Agent",
				ownerUserId: "toolbox-user-admin",
				settings: {},
			}),
		});

		expect(response.status).toBe(201);

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
