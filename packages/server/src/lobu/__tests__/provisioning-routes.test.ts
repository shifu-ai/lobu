import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context.js";

const ORG_ID = "org-provisioning";

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

async function buildApp(scopes: string[] = ["mcp:admin"]) {
	const { provisioningRoutes } = await import("../provisioning-routes.js");
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
	app.route("/api/provisioning", provisioningRoutes);
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
