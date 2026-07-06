import { describe, expect, mock, test } from "bun:test";
import type { AgentMetadata, AgentSettings } from "@lobu/core";
import { Hono } from "hono";
import { createLobuConfigStatusRoutes } from "../config-status-routes.js";
import type {
	LobuConfigStatusStore,
	LobuOAuthStatusProvider,
} from "../config-status-service.js";

const TOKEN = "test-service-token";
const AGENT_ID = "shifu-u-abc123";
const USER_ID = "toolbox-user-1";

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
	oauthStatusProvider?: LobuOAuthStatusProvider,
) {
	const app = new Hono();
	app.route(
		"/internal/lobu-config",
		createLobuConfigStatusRoutes({
			token: TOKEN,
			store,
			oauthStatusProvider,
		}),
	);
	return app;
}

function ownedMetadata(overrides: Partial<AgentMetadata> = {}): AgentMetadata {
	return {
		agentId: AGENT_ID,
		name: "Personal Agent",
		owner: { platform: "toolbox", userId: USER_ID },
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
			{
				getOAuthStatus: mock(async () => "authorized"),
			},
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
		expect(body.connectors).toContainEqual({
			key: "shifu_toolbox",
			oauthStatus: "authorized",
			agentToolStatus: "usable",
			configured: true,
			authorized: true,
		});
		expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|credential|secret/i);
	});

	test("reports expired or unusable credentials as needing reauth", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
			{
				getOAuthStatus: mock(async () => "needs_reauth"),
			},
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual({
			key: "shifu_toolbox",
			oauthStatus: "needs_reauth",
			agentToolStatus: "usable",
			configured: true,
			authorized: false,
		});
	});

	test("reports missing credentials as not connected", async () => {
		const app = buildApp(
			buildStore({
				metadata: ownedMetadata(),
				settings: { mcpServers: { "shifu-toolbox": { url: "https://mcp.example.test" } } },
			}),
			{
				getOAuthStatus: mock(async () => "not_connected"),
			},
		);

		const res = await app.request(
			`/internal/lobu-config/current?agentId=${AGENT_ID}&userId=${USER_ID}`,
			{ headers: { Authorization: `Bearer ${TOKEN}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connectors).toContainEqual({
			key: "shifu_toolbox",
			oauthStatus: "not_connected",
			agentToolStatus: "usable",
			configured: true,
			authorized: false,
		});
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
		expect(body.connectors).toContainEqual({
			key: "shifu_toolbox",
			oauthStatus: "unknown",
			agentToolStatus: "not_usable",
			configured: false,
			authorized: false,
		});
	});
});
