import { describe, expect, mock, test } from "bun:test";
import type { AgentMetadata, AgentSettings } from "@lobu/core";
import { Hono } from "hono";
import { createLobuConfigStatusRoutes } from "../config-status-routes.js";
import type { WritableSecretStore } from "../../gateway/secrets/index.js";
import type {
	LobuConfigStatusStore,
	LobuOAuthStatusProvider,
} from "../config-status-service.js";
import { orgContext } from "../stores/org-context.js";

const TOKEN = "test-service-token";
const AGENT_ID = "shifu-u-abc123";
const USER_ID = "toolbox-user-1";
const ORG_ID = "org-status-test";
const SECRET_NAME = `mcp-auth/${AGENT_ID}/${USER_ID}/notion/credential`;
const SECRET_REF = `secret://${encodeURIComponent(SECRET_NAME)}`;

function buildStore(options: {
	metadata?: AgentMetadata | null;
	settings?: AgentSettings | null;
}): LobuConfigStatusStore {
	return {
		getMetadata: mock(async () => options.metadata ?? null),
		getSettings: mock(async () => options.settings ?? null),
	};
}

function buildApp(
	store: LobuConfigStatusStore,
	options: {
		oauthStatusProvider?: LobuOAuthStatusProvider;
		secretStore?: WritableSecretStore;
		getSecretStore?: () => WritableSecretStore | undefined;
	} = {},
) {
	const app = new Hono();
	app.route(
		"/internal/lobu-config",
		createLobuConfigStatusRoutes({
			token: TOKEN,
			store,
			oauthStatusProvider: options.oauthStatusProvider,
			secretStore: options.secretStore,
			getSecretStore: options.getSecretStore,
		}),
	);
	return app;
}

function buildSecretStore(
	overrides: Partial<WritableSecretStore> = {},
): WritableSecretStore {
	return {
		get: mock(async () => null),
		put: mock(async () => "secret://stub"),
		delete: mock(async () => {}),
		list: mock(async () => []),
		...overrides,
	};
}

function ownedMetadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
	return {
		agentId: AGENT_ID,
		name: "Personal Agent",
		owner: { platform: "toolbox", userId: USER_ID },
		organizationId: ORG_ID,
		createdAt: Date.now(),
		...overrides,
	};
}

describe("Lobu config current status routes", () => {
	test("requires bearer auth", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
		);

		expect(res.status).toBe(401);
	});

	test("rejects a wrong service token", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: "Bearer wrong-token" } },
		);

		expect(res.status).toBe(401);
	});

	test("validates agentId and userId", async () => {
		const app = buildApp(buildStore({ metadata: ownedMetadata(), settings: {} }));

		const res = await app.request("/internal/lobu-config/current?agentId=&userId=", {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});

		expect(res.status).toBe(400);
	});

	test("returns 404 when the Toolbox user does not own the agent", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata({ owner: { platform: "toolbox", userId: "other-user" } }),
				settings: {},
			}),
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: "agent_owner_mismatch" });
	});

	test("reports authorized OAuth credentials without returning token-like fields", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						"shifu-toolbox": {
							url: "https://mcp.example.test",
							headers: { Authorization: "Bearer should-not-leak" },
						},
					},
				},
			}),
			{ oauthStatusProvider: { getOAuthStatus: mock(async () => "authorized") } },
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			ok: true,
			agentId: AGENT_ID,
			userId: USER_ID,
			checkedAt: expect.any(Number),
		});
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "shifu_toolbox",
				oauthStatus: "authorized",
				agentToolStatus: "usable",
				configured: true,
				authorized: true,
			}),
		);
		expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|credential|secret/i);
	});

	test("reports expired or unusable credentials as needing reauth", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
			{ oauthStatusProvider: { getOAuthStatus: mock(async () => "needs_reauth") } },
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "shifu_toolbox",
				oauthStatus: "needs_reauth",
				agentToolStatus: "usable",
				configured: true,
				authorized: false,
			}),
		);
	});

	test("reports missing credentials as not connected", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
			{ oauthStatusProvider: { getOAuthStatus: mock(async () => "not_connected") } },
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "shifu_toolbox",
				oauthStatus: "not_connected",
				agentToolStatus: "usable",
				configured: true,
				authorized: false,
			}),
		);
	});

	test("looks up OAuth credentials inside the agent organization context", async () => {
		const secretStore = buildSecretStore({
			get: mock(async (ref) => {
				if (orgContext.getStore()?.organizationId !== ORG_ID) return null;
				if (ref !== SECRET_REF) return null;
				return JSON.stringify({
					accessToken: "secret-token",
					refreshToken: "secret-refresh",
					expiresAt: 4_102_444_800_000,
					clientId: "client-1",
					tokenUrl: "https://auth.example.test/token",
				});
			}),
		});
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { notion: { url: "https://mcp.notion.test/mcp" } } },
			}),
			{ secretStore },
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "notion",
				oauthStatus: "authorized",
				agentToolStatus: "usable",
				configured: true,
				authorized: true,
				reasonCode: "ok",
			}),
		);
	});

	test("returns reason detail for a configured connector with no user credential", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata({
					agentId: "shifu-u-status-detail",
					owner: { platform: "toolbox", userId: "toolbox-user-001" },
				}),
				settings: {
					mcpServers: {
						notion: { url: "https://mcp.notion.test/mcp" },
					},
					allowedTools: ["notion_search"],
					preApprovedTools: ["notion_search"],
				},
			}),
			{ oauthStatusProvider: { getOAuthStatus: mock(async () => "not_connected") } },
		);

		const response = await app.request(
			"/internal/lobu-config/current?agentId=shifu-u-status-detail&userId=toolbox-user-001",
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "notion",
				configured: true,
				authorized: false,
				oauthStatus: "not_connected",
				agentToolStatus: "usable",
				reasonCode: "missing_credential",
				reauthorizationAvailable: true,
				authorizationUrlAvailable: true,
				uiManaged: true,
				toolNames: ["notion_search"],
			}),
		);
	});

	test("reports absent MCP servers as not usable", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: {} },
			}),
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { "x-internal-token": TOKEN } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "shifu_toolbox",
				oauthStatus: "unknown",
				agentToolStatus: "not_usable",
				configured: false,
				authorized: false,
			}),
		);
	});

	test("returns ok reason for an authorized configured connector", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						google_workspace: { url: "https://mcp.google.test/mcp" },
					},
					preApprovedTools: ["/mcp/google_workspace/tools/gws_calendar_events_list"],
				},
			}),
			{ oauthStatusProvider: { getOAuthStatus: mock(async () => "authorized") } },
		);

		const response = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "google_workspace",
				authorized: true,
				oauthStatus: "authorized",
				agentToolStatus: "usable",
				reasonCode: "ok",
				reauthorizationAvailable: true,
				authorizationUrlAvailable: true,
				uiManaged: true,
				toolNames: ["gws_calendar_events_list"],
			}),
		);
	});

	test("reports expired access token with a refresh token as authorized", async () => {
		const secretStore = buildSecretStore({
			get: mock(async (ref) => {
				expect(ref).toBe(SECRET_REF);
				return JSON.stringify({
					accessToken: "expired-access-token",
					refreshToken: "usable-refresh-token",
					expiresAt: Date.now() - 60_000,
					clientId: "test-client",
					tokenUrl: "https://oauth.example.test/token",
				});
			}),
		});
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						notion: { url: "https://mcp.notion.test/mcp" },
					},
					preApprovedTools: ["/mcp/notion/tools/notion_search"],
				},
			}),
			{ secretStore },
		);

		const response = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "notion",
				authorized: true,
				oauthStatus: "authorized",
				reasonCode: "ok",
				reauthorizationAvailable: true,
				authorizationUrlAvailable: true,
				toolNames: ["notion_search"],
			}),
		);
	});

	test("returns needs_reauth for an expired access token without a refresh token", async () => {
		const secretStore = buildSecretStore({
			get: mock(async (ref) => {
				expect(ref).toBe(SECRET_REF);
				return JSON.stringify({
					accessToken: "expired-access-token",
					expiresAt: Date.now() - 60_000,
					clientId: "test-client",
					tokenUrl: "https://oauth.example.test/token",
				});
			}),
		});
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						notion: { url: "https://mcp.notion.test/mcp" },
					},
					preApprovedTools: ["/mcp/notion/tools/notion_search"],
				},
			}),
			{ secretStore },
		);

		const response = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "notion",
				authorized: false,
				oauthStatus: "needs_reauth",
				reasonCode: "token_expired",
				reauthorizationAvailable: true,
				authorizationUrlAvailable: true,
				toolNames: ["notion_search"],
			}),
		);
	});

	test("treats malformed credential JSON as provider_error without leaking secret details", async () => {
		const secretStore = buildSecretStore({
			get: mock(async (ref) => {
				expect(ref).toBe(SECRET_REF);
				return '{"accessToken":"top-secret-token"';
			}),
		});
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						notion: { url: "https://mcp.notion.test/mcp" },
					},
				},
			}),
			{ secretStore },
		);

		const response = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "notion",
				authorized: false,
				oauthStatus: "unknown",
				reasonCode: "provider_error",
				reauthorizationAvailable: true,
				authorizationUrlAvailable: true,
			}),
		);
		expect(JSON.stringify(body)).not.toContain(SECRET_NAME);
		expect(JSON.stringify(body)).not.toContain("top-secret-token");
	});

	test("marks runtime connectors outside Toolbox UI as unmanaged", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: {
					mcpServers: {
						"lobu-memory": { url: "https://mcp.lobu-memory.test/mcp" },
					},
				},
			}),
		);

		const response = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.connectors).toContainEqual(
			expect.objectContaining({
				key: "lobu-memory",
				configured: true,
				agentToolStatus: "usable",
				reasonCode: "ui_unmanaged_connector",
				reauthorizationAvailable: false,
				authorizationUrlAvailable: false,
				uiManaged: false,
			}),
		);
	});
});
