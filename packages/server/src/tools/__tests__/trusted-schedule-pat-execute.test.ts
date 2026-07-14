import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { executeTool, type AuthContext } from "../execute";

const ORGANIZATION_ID = "org-trusted-schedule-pat";
const USER_ID = "pm-trusted-schedule-pat";
const AGENT_ID = "shifu-u-trusted-schedule-pat";
const CREATION_KEY = "toolbox:automation:execute-boundary";

function trustedPat(overrides: Partial<AuthContext> = {}): AuthContext {
	return {
		organizationId: ORGANIZATION_ID,
		tokenOrganizationId: ORGANIZATION_ID,
		userId: USER_ID,
		memberRole: "member",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:admin"],
		tokenType: "pat",
		requestUrl: "http://localhost/internal/tools/manage_schedules",
		baseUrl: "http://localhost",
		scopedToOrg: true,
		allowCrossOrg: false,
		allowInternalTools: true,
		...overrides,
	};
}

describe("executeTool trusted schedule PAT boundary", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	}, 60_000);

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow(AGENT_ID, {
			organizationId: ORGANIZATION_ID,
			ownerPlatform: "toolbox",
			ownerUserId: USER_ID,
		});
	}, 30_000);

	test("verified organization PAT with mcp:admin executes staged create, lookup, and activate", async () => {
		const auth = trustedPat();
		const created = (await executeTool(
			"manage_schedules",
			{
				action: "create",
				description: "execute boundary",
				creation_key: CREATION_KEY,
				initial_state: "staged",
				run_at: "2030-07-15T09:00:00.000Z",
				payload: {
					type: "wake_agent",
					agent_id: AGENT_ID,
					prompt: "follow up",
				},
			},
			{} as never,
			auth,
		)) as { status: string; schedule: { id: string; state: string } };
		expect(created.status).toBe("staged");
		expect(created.schedule.state).toBe("staged");

		const found = (await executeTool(
			"manage_schedules",
			{ action: "get_by_creation_key", creation_key: CREATION_KEY },
			{} as never,
			auth,
		)) as { found: boolean; schedule: { id: string; state: string } };
		expect(found.found).toBe(true);
		expect(found.schedule.id).toBe(created.schedule.id);

		const activated = (await executeTool(
			"manage_schedules",
			{
				action: "activate",
				creation_key: CREATION_KEY,
				expected_schedule_id: created.schedule.id,
			},
			{} as never,
			auth,
		)) as { status: string; schedule: { id: string; state: string } };
		expect(activated.status).toBe("active");
		expect(activated.schedule).toMatchObject({ id: created.schedule.id, state: "active" });
	});

	test.each([
		["session", trustedPat({ tokenType: "session", tokenOrganizationId: null })],
		["OAuth", trustedPat({ tokenType: "oauth", tokenOrganizationId: ORGANIZATION_ID })],
		["unverified PAT", trustedPat({ isAuthenticated: false })],
		[
			"PAT bound to another organization",
			trustedPat({ tokenOrganizationId: "org-other" }),
		],
		[
			"ordinary member PAT",
			trustedPat({ scopes: ["mcp:read", "mcp:write"] }),
		],
	])("%s cannot execute staged schedule actions even with forged-looking context", async (_label, auth) => {
		for (const args of [
			{
				action: "create",
				description: "blocked",
				creation_key: `${CREATION_KEY}:blocked`,
				initial_state: "staged",
				run_at: "2030-07-15T09:00:00.000Z",
				payload: { type: "wake_agent", agent_id: AGENT_ID, prompt: "blocked" },
			},
			{ action: "get_by_creation_key", creation_key: CREATION_KEY },
			{
				action: "activate",
				creation_key: CREATION_KEY,
				expected_schedule_id: "00000000-0000-4000-8000-000000000042",
			},
		]) {
			await expect(
				executeTool("manage_schedules", args, {} as never, auth),
			).rejects.toThrow(/admin or owner access/i);
		}
	});

	test("trusted schedule PAT does not gain access to unrelated admin tools", async () => {
		await expect(
			executeTool(
				"manage_connections",
				{ action: "delete", id: "connection-private" },
				{} as never,
				trustedPat(),
			),
		).rejects.toThrow(/admin or owner access/i);
	});
});
