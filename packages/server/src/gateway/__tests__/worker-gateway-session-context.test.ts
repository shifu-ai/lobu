import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	encrypt,
	generateWorkerToken,
	type AgentConnectionStore,
	type SecretRef,
} from "@lobu/core";
import { WorkerGateway } from "../gateway/index.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { SecretListEntry, WritableSecretStore } from "../secrets/index.js";

const fakeConnections = new Map<string, any>();

function createFakeConnectionStore(): AgentConnectionStore {
	return {
		getConnection: async (connectionId: string) =>
			fakeConnections.get(connectionId) ?? null,
		listConnections: async (filter?: { agentId?: string; platform?: string }) =>
			[...fakeConnections.values()].filter((connection) => {
				if (connection.organizationId !== orgContext.getStore()?.organizationId) {
					return false;
				}
				if (filter?.agentId && connection.agentId !== filter.agentId) {
					return false;
				}
				if (filter?.platform && connection.platform !== filter.platform) {
					return false;
				}
				return true;
			}),
		saveConnection: async (connection: any) => {
			fakeConnections.set(connection.id, connection);
		},
		updateConnection: async (connectionId: string, updates: any) => {
			const existing = fakeConnections.get(connectionId);
			if (existing) fakeConnections.set(connectionId, { ...existing, ...updates });
		},
		deleteConnection: async (connectionId: string) => {
			fakeConnections.delete(connectionId);
		},
	};
}

const TEST_ENCRYPTION_KEY = Buffer.from(
	"12345678901234567890123456789012",
).toString("base64");

describe("WorkerGateway session context", () => {
	const previousEncryptionKey = process.env.ENCRYPTION_KEY;

	beforeEach(() => {
		process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
		fakeConnections.clear();
	});

	afterEach(() => {
		if (previousEncryptionKey === undefined) {
			delete process.env.ENCRYPTION_KEY;
		} else {
			process.env.ENCRYPTION_KEY = previousEncryptionKey;
		}
		mock.restore();
	});

	test("syncs only agent-configured skills into skillsConfig", async () => {
		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions:
						"## Skills\n\n- **Custom Skill** (`owner/custom-skill`)",
					mcpStatus: [],
				}),
			} as any,
			undefined,
			undefined,
			{
				getSettings: async () => ({
					skillsConfig: {
						skills: [
							{
								name: "custom-skill",
								enabled: true,
								content: "# Custom Skill\n",
							},
						],
					},
				}),
			} as any,
		);

		const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
			channelId: "channel-1",
			agentId: "agent-1",
		});

		const response = await gateway.getApp().request("/session-context", {
			headers: {
				authorization: `Bearer ${token}`,
				host: "gateway.example.com",
			},
		});

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			userId: string;
			agentId: string;
			skillsConfig: Array<{ name: string; content: string }>;
			skillsInstructions: string;
		};

		expect(body.userId).toBe("user-1");
		expect(body.agentId).toBe("agent-1");
		expect(body.skillsConfig).toEqual([
			{ name: "custom-skill", content: "# Custom Skill\n" },
		]);
		expect(body.skillsInstructions).toContain("## Skills");
		expect(body.skillsInstructions).toContain("owner/custom-skill");
		expect(body.skillsInstructions).not.toContain("Built-in System Skills");
	});

	test("looks up MCP credentials inside worker token organization context", async () => {
		class OrgAwareSecretStore implements WritableSecretStore {
			async get(ref: SecretRef): Promise<string | null> {
				if (orgContext.getStore()?.organizationId !== "org-a") return null;
				if (
					ref !==
					("secret://mcp-auth%2Fagent-1%2Fuser-1%2Fshifu-toolbox%2Fcredential" as SecretRef)
				) {
					return null;
				}
				return JSON.stringify({
					accessToken: "access-token",
					refreshToken: "refresh-token",
					expiresAt: Date.now() + 60_000,
					clientId: "client-id",
					tokenUrl: "https://auth.example.test/token",
				});
			}
			async put(): Promise<SecretRef> {
				throw new Error("not used");
			}
			async delete(): Promise<void> {
				throw new Error("not used");
			}
			async list(): Promise<SecretListEntry[]> {
				return [];
			}
		}

		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [
						{
							id: "shifu-toolbox",
							name: "ShiFu Toolbox",
							requiresAuth: true,
							requiresInput: false,
							upstreamOrigin: "https://mcp.shifu-ai.org",
							configSource: "agent",
						},
					],
				}),
			} as any,
			undefined,
			undefined,
			undefined,
			new OrgAwareSecretStore(),
			createFakeConnectionStore(),
		);

		const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
			channelId: "channel-1",
			agentId: "agent-1",
			organizationId: "org-a",
		});

		const response = await gateway.getApp().request("/session-context", {
			headers: {
				authorization: `Bearer ${token}`,
				host: "gateway.example.com",
			},
		});

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			mcpStatus: Array<{
				id: string;
				authenticated: boolean;
				upstreamOrigin: string;
				configSource: string;
			}>;
		};

		expect(body.mcpStatus).toContainEqual({
			id: "shifu-toolbox",
			name: "ShiFu Toolbox",
			requiresAuth: true,
			requiresInput: false,
			authenticated: true,
			configured: true,
			upstreamOrigin: "https://mcp.shifu-ai.org",
			configSource: "agent",
		});
	});

	test("binds MCP status provenance to the config used for tool discovery", async () => {
		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [
						{
							id: "shifu-toolbox",
							name: "ShiFu Toolbox",
							requiresAuth: false,
							requiresInput: false,
							upstreamOrigin: "https://stale-or-evil.example",
							configSource: "global",
						},
						{
							id: "unbound-catalog",
							name: "Unbound Catalog",
							requiresAuth: false,
							requiresInput: false,
							upstreamOrigin: "https://mcp.shifu-ai.org",
							configSource: "agent",
						},
					],
				}),
			} as any,
			{
				fetchToolsForMcp: async (mcpId: string) =>
					mcpId === "shifu-toolbox"
						? {
								tools: [{ name: "plan_automation" }],
								provenance: {
									upstreamOrigin: "https://mcp.shifu-ai.org",
									configSource: "agent",
								},
							}
						: { tools: [{ name: "create_automation" }] },
			} as any,
		);

		const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
			channelId: "channel-1",
			agentId: "agent-1",
		});

		const response = await gateway.getApp().request("/session-context", {
			headers: {
				authorization: `Bearer ${token}`,
				host: "gateway.example.com",
			},
		});
		const body = (await response.json()) as {
			mcpStatus: Array<{
				id: string;
				upstreamOrigin?: string;
				configSource?: string;
			}>;
		};

		expect(response.status).toBe(200);
		expect(body.mcpStatus[0]).toMatchObject({
			id: "shifu-toolbox",
			upstreamOrigin: "https://mcp.shifu-ai.org",
			configSource: "agent",
		});
		expect(body.mcpStatus[1]).toMatchObject({
			id: "unbound-catalog",
			upstreamOrigin: "",
			configSource: "derived",
		});
	});

	test("exposes ready materialized personal-agent connectors as toolboxPersonalAgentTools", async () => {
		fakeConnections.set(
			"toolbox-mcp:org-1:user-1:agent-1:google_workspace",
			{
				id: "toolbox-mcp:org-1:user-1:agent-1:google_workspace",
				organizationId: "org-1",
				agentId: "agent-1",
				platform: "google_workspace",
				config: {},
				settings: {},
				metadata: {
					source: "toolbox-personal-agent-materialized",
					ownerUserId: "user-1",
					connectorKey: "google_workspace",
				},
				status: "active",
			},
		);
		fakeConnections.set("toolbox-mcp:org-1:user-1:agent-1:notion", {
			id: "toolbox-mcp:org-1:user-1:agent-1:notion",
			organizationId: "org-1",
			agentId: "agent-1",
			platform: "notion",
			config: {},
			settings: {},
			metadata: {
				source: "toolbox-personal-agent-materialized",
				ownerUserId: "user-1",
				connectorKey: "notion",
			},
			status: "active",
		});
		fakeConnections.set("toolbox-mcp:org-1:user-1:agent-1:shifu_toolbox", {
			id: "toolbox-mcp:org-1:user-1:agent-1:shifu_toolbox",
			organizationId: "org-1",
			agentId: "agent-1",
			platform: "shifu-toolbox",
			config: {},
			settings: {},
			metadata: {
				source: "toolbox-personal-agent-materialized",
				ownerUserId: "user-1",
				connectorKey: "shifu_toolbox",
				mcpId: "shifu-toolbox",
			},
			status: "active",
		});

		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [],
				}),
			} as any,
			undefined,
			undefined,
			undefined,
			undefined,
			createFakeConnectionStore(),
		);

		const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
			channelId: "channel-1",
			agentId: "agent-1",
			organizationId: "org-1",
		});

		const response = await gateway.getApp().request("/session-context", {
			headers: {
				authorization: `Bearer ${token}`,
				host: "gateway.example.com",
			},
		});

		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			toolboxPersonalAgentTools?: Array<{
				connectorKey: string;
				connectionRef: string;
				tools: Array<{
					name: string;
					connectorToolName: string;
					approvalRequired: boolean;
				}>;
			}>;
		};

		const googleWorkspaceTools = body.toolboxPersonalAgentTools?.find(
			(group) => group.connectorKey === "google_workspace",
		);
		expect(googleWorkspaceTools?.connectorKey).toBe("google_workspace");
		expect(googleWorkspaceTools?.connectionRef).toBe(
			"toolbox-mcp:org-1:user-1:agent-1:google_workspace",
		);
		expect(googleWorkspaceTools?.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "google_workspace_drive_search",
					connectorToolName: "gws_drive_search",
					approvalRequired: false,
				}),
				expect.objectContaining({
					name: "google_workspace_docs_create",
					connectorToolName: "gws_docs_create",
					approvalRequired: true,
				}),
				expect.objectContaining({
					name: "google_workspace_calendar_events_list",
					connectorToolName: "gws_calendar_events_list",
					approvalRequired: false,
				}),
				expect.objectContaining({
					name: "google_workspace_calendar_events_create",
					connectorToolName: "gws_calendar_events_create",
					approvalRequired: true,
				}),
				expect.objectContaining({
					name: "google_workspace_calendar_events_update",
					connectorToolName: "gws_calendar_events_update",
					approvalRequired: true,
				}),
				expect.objectContaining({
					name: "google_workspace_calendar_events_delete",
					connectorToolName: "gws_calendar_events_delete",
					approvalRequired: true,
				}),
				expect.objectContaining({
					name: "google_workspace_chat_messages_create",
					connectorToolName: "gws_chat_messages_create",
					approvalRequired: true,
				}),
			]),
		);
		const notionTools = body.toolboxPersonalAgentTools?.find(
			(group) => group.connectorKey === "notion",
		);
		expect(notionTools?.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "notion_search",
					connectorToolName: "notion-search",
					approvalRequired: false,
				}),
				expect.objectContaining({
					name: "notion_create_pages",
					connectorToolName: "notion-create-pages",
					approvalRequired: true,
				}),
				expect.objectContaining({
					name: "notion_update_page",
					connectorToolName: "notion-update-page",
					approvalRequired: true,
				}),
			]),
		);
		const shifuToolboxTools = body.toolboxPersonalAgentTools?.find(
			(group) => group.connectorKey === "shifu_toolbox",
		);
		expect(shifuToolboxTools?.connectionRef).toBe(
			"toolbox-mcp:org-1:user-1:agent-1:shifu_toolbox",
		);
		expect(shifuToolboxTools?.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "submit_course_pm_profile",
					connectorToolName: "submit_course_pm_profile",
					approvalRequired: false,
				}),
				expect.objectContaining({
					name: "meeting_search",
					connectorToolName: "meeting_search",
					approvalRequired: false,
				}),
			]),
		);
	});

	test("executes materialized personal-agent tools through worker authentication", async () => {
		fakeConnections.set("toolbox-mcp:ref", {
			id: "toolbox-mcp:ref",
			organizationId: "org-1",
			agentId: "agent-1",
			platform: "google_workspace",
			config: {},
			settings: {},
			metadata: {
				source: "toolbox-personal-agent-materialized",
				ownerUserId: "user-1",
				connectorKey: "google_workspace",
				mcpId: "google_workspace",
			},
			status: "active",
		});
		const executeToolDirect = mock(async () => ({
			content: [{ type: "text", text: "found drive files" }],
		}));
		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [],
				}),
			} as any,
			{ executeToolDirect } as any,
			undefined,
			undefined,
			undefined,
			createFakeConnectionStore(),
		);
		const token = generateWorkerToken("user-1", "conv-1", "worker-a", {
			channelId: "channel-1",
			agentId: "agent-1",
			organizationId: "org-1",
		});

		const response = await gateway.getApp().request(
			"/internal/toolbox-personal-agent-tools/call",
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					connectorKey: "google_workspace",
					connectionRef: "toolbox-mcp:ref",
					connectorToolName: "gws_drive_search",
					args: { query: "超級AI個體" },
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			content: [{ type: "text", text: "found drive files" }],
		});
		expect(executeToolDirect).toHaveBeenCalledWith(
			"agent-1",
			"user-1",
			"google_workspace",
			"gws_drive_search",
			{ query: "超級AI個體" },
		);
	});

	test("fails closed for catalog meeting_search on a course run before personal-agent execution", async () => {
		fakeConnections.set("toolbox-mcp:ref", {
			id: "toolbox-mcp:ref", organizationId: "org-1", agentId: "agent-1", platform: "shifu_toolbox", config: {}, settings: {},
			metadata: { source: "toolbox-personal-agent-materialized", ownerUserId: "user-1", connectorKey: "shifu_toolbox", mcpId: "shifu_toolbox" }, status: "active",
		});
		const executeToolDirect = mock(async () => ({ content: [], isError: false }));
		const callToolWithApproval = mock(async () => ({ status: "executed" as const, content: [], isError: false }));
		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any, "https://gateway.example.com", { getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
			{ getSessionContext: async () => ({ agentInstructions: "", platformInstructions: "", networkInstructions: "", skillsInstructions: "", mcpStatus: [] }) } as any,
			{ executeToolDirect, callToolWithApproval } as any, undefined, undefined, undefined, createFakeConnectionStore(),
		);
		const scopedToken = generateWorkerToken("user-1", "conv-1", "worker-a", { channelId: "channel-1", agentId: "agent-1", organizationId: "org-1", tokenKind: "run", runId: 81, courseToolScope: { ownerUserId: "user-1", agentId: "agent-1", courseEntityId: "course:user-1:a" } });
		const request = (token: string, connectorToolName: string) => gateway.getApp().request("/internal/toolbox-personal-agent-tools/call", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ connectorKey: "shifu_toolbox", connectionRef: "toolbox-mcp:ref", connectorToolName, args: { query: "weekly", bypassCourseScope: true } }) });
		const blocked = await request(scopedToken, "meeting_search");
		expect(blocked.status).toBe(409);
		expect(await blocked.json()).toMatchObject({ ok: false, errorCode: "COURSE_MEETING_SCOPE_UNAVAILABLE", diagnosticCode: "COURSE_MEETING_SCOPE_UNAVAILABLE" });
		expect(callToolWithApproval).not.toHaveBeenCalled(); expect(executeToolDirect).not.toHaveBeenCalled();

		const unscopedToken = generateWorkerToken("user-1", "conv-1", "worker-a", { channelId: "channel-1", agentId: "agent-1", organizationId: "org-1" });
		expect((await request(unscopedToken, "meeting_search")).status).toBe(200);
		expect((await request(scopedToken, "submit_course_pm_profile")).status).toBe(200);
		expect(callToolWithApproval).toHaveBeenCalledTimes(2);
	});

	test("approval-blocks materialized personal-agent write tools before direct execution", async () => {
		fakeConnections.set("toolbox-mcp:ref", {
			id: "toolbox-mcp:ref",
			organizationId: "org-1",
			agentId: "agent-1",
			platform: "google_workspace",
			config: {},
			settings: {},
			metadata: {
				source: "toolbox-personal-agent-materialized",
				ownerUserId: "user-1",
				connectorKey: "google_workspace",
				mcpId: "google_workspace",
			},
			status: "active",
		});

		const executeToolDirect = mock(async () => ({
			content: [{ type: "text", text: "created doc" }],
			isError: false,
		}));
		const callToolWithApproval = mock(async () => ({
			status: "blocked-notified" as const,
			content: [
				{
					type: "text",
					text: "Tool call requires approval. The user has been asked to approve.",
				},
			],
			isError: true,
		}));

		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{ getWorkerConfig: async () => ({ mcpServers: {} }) } as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [],
				}),
			} as any,
			{ executeToolDirect, callToolWithApproval } as any,
			undefined,
			undefined,
			undefined,
			createFakeConnectionStore(),
		);

		const token = encrypt(
			JSON.stringify({
				userId: "user-1",
				conversationId: "conv-1",
				deploymentName: "worker-a",
				channelId: "channel-1",
				agentId: "agent-1",
				organizationId: "org-1",
				platform: "line",
				timestamp: Date.now(),
			}),
		);

		const response = await gateway.getApp().request(
			"/internal/toolbox-personal-agent-tools/call",
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					connectorKey: "google_workspace",
					connectionRef: "toolbox-mcp:ref",
					connectorToolName: "gws_docs_create",
					args: { title: "PM weekly summary" },
				}),
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: false,
			content: [
				{
					type: "text",
					text: "Tool call requires approval. The user has been asked to approve.",
				},
			],
			errorCode: "lobu_mcp_approval_required",
			errorMessage: "MCP tool call requires approval",
		});
		expect(callToolWithApproval).toHaveBeenCalledWith(
			"agent-1",
			"user-1",
			"google_workspace",
			"gws_docs_create",
			{ title: "PM weekly summary" },
			expect.objectContaining({
				channelId: "channel-1",
				conversationId: "conv-1",
				organizationId: "org-1",
				platform: "line",
			}),
		);
		expect(executeToolDirect).not.toHaveBeenCalled();
	});

	test("rejects materialized personal-agent tool calls without worker authentication", async () => {
		const gateway = new WorkerGateway(
			{ send: async () => undefined } as any,
			"https://gateway.example.com",
			{
				getWorkerConfig: async () => ({ mcpServers: {} }),
			} as any,
			{
				getSessionContext: async () => ({
					agentInstructions: "",
					platformInstructions: "",
					networkInstructions: "",
					skillsInstructions: "",
					mcpStatus: [],
				}),
			} as any,
			undefined,
			undefined,
			undefined,
			undefined,
			createFakeConnectionStore(),
		);

		const response = await gateway.getApp().request(
			"/internal/toolbox-personal-agent-tools/call",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					connectorKey: "google_workspace",
					connectionRef: "toolbox-mcp:ref",
					connectorToolName: "drive_search",
					args: { query: "超級AI個體" },
				}),
			},
		);

		expect(response.status).toBe(401);
	});
});
