import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
	startAuthCodeFlow: startAuthCodeFlowMock,
}));

beforeAll(async () => {
	await ensureDbForGatewayTests();
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
	const { createProvisioningRoutes } = await import("../provisioning-routes.js");
	const app = new Hono();
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

describe("POST /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/start", () => {
	beforeEach(async () => {
		startAuthCodeFlowMock.mockClear();
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("starts a browser OAuth flow for a shifu personal agent MCP", async () => {
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
			authorizationUrl:
				"https://auth.example.test/authorize?state=test-state",
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
});

describe("GET /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/status", () => {
	beforeEach(async () => {
		await resetTestDatabase();
		await seedOrg(ORG_ID);
	});

	test("reports whether the scoped MCP OAuth credential exists without exposing it", async () => {
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
});
