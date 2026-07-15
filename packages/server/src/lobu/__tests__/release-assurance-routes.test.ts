import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createProvisioningRoutes } from "../provisioning-routes";
import { orgContext } from "../stores/org-context";

const ORG_ID = "org-release-readback";

function appWith(
	readback: {
		readRuntime(): Promise<unknown>;
		readAgent(input: {
			organizationId: string;
			agentId: string;
		}): Promise<unknown | null>;
	},
	scopes = ["mcp:admin"],
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { id: "gateway-user" });
		c.set("session", { id: "pat:test-client" });
		c.set("organizationId", ORG_ID);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId: ORG_ID }, next);
	});
	app.route(
		"/api/provisioning",
		createProvisioningRoutes({ releaseAssuranceReadback: readback }),
	);
	return app;
}

describe("release assurance bounded provisioning readback", () => {
	it("requires an organization-scoped mcp:admin PAT", async () => {
		const response = await appWith(
			{ readRuntime: async () => ({}), readAgent: async () => null },
			[],
		).request("/api/provisioning/release-assurance");
		expect(response.status).toBe(403);
	});

	it("returns the injected bounded runtime truth without accepting a caller URL", async () => {
		const runtime = {
			schemaVersion: 1,
			service: "lobu-runtime",
			revision: "rev-1",
		};
		const response = await appWith({
			readRuntime: async () => runtime,
			readAgent: async () => null,
		}).request(
			"/api/provisioning/release-assurance?url=https://attacker.invalid",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(runtime);
	});

	it("fails a cross-organization or unknown agent closed as not found", async () => {
		const response = await appWith({
			readRuntime: async () => ({}),
			readAgent: async () => null,
		}).request("/api/provisioning/agents/shifu-u-missing/release-assurance");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "agent_release_assurance_not_found",
		});
	});
});
