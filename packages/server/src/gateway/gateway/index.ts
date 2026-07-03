#!/usr/bin/env bun

import type {
	AgentConnectionStore,
	ConfigProviderMeta,
	InstructionContext,
	StoredConnection,
	WorkerTokenData,
} from "@lobu/core";
import { createLogger, encrypt, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { bindRequestAbortToStream } from "../../events/sse-abort-bridge.js";
import type { ApiKeyProviderModule } from "../auth/api-key-provider-module.js";
import { getRevokedTokenStore } from "../auth/revoked-token-store.js";
import type { McpConfigService } from "../auth/mcp/config-service.js";
import type { McpProxy } from "../auth/mcp/proxy.js";
import type { McpTool } from "../auth/mcp/tool-cache.js";
import type { ProviderCatalogService } from "../auth/provider-catalog.js";
import { getStoredCredential } from "../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../secrets/index.js";
import type { ShifuTraceContext } from "../../observability/trace-context.js";
import { resolveEffectiveModelRef } from "../auth/settings/model-selection.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import {
	commitTerminalReply,
	extendTurnDeadlines,
} from "../orchestration/turn-liveness.js";
import { emitJourneyEvent as emitJourneyObsEvent } from "../services/journey-observability.js";
import type { InstructionService } from "../services/instruction-service.js";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { parseShifuTraceHeaders } from "../trace-context.js";
import {
	type SSEWriter,
	WorkerConnectionManager,
} from "./connection-manager.js";
import { WorkerJobRouter } from "./job-router.js";
import { createTranscriptRoutes } from "./transcript-routes.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { createPostgresAgentConnectionStore } from "../../lobu/stores/postgres-stores.js";
import { createExecutionTaskStatusRoutes } from "../routes/public/execution-tasks.js";
import { createExecutionEventRoutes } from "../routes/internal/execution-events.js";

const logger = createLogger("worker-gateway");

/**
 * Minimal interface onto the deployment manager's idle clock. Any worker-driven
 * signal must refresh the deployment's lastActivity so the idle reaper does
 * not scale a long-running active worker to 0 mid-turn.
 */
export interface DeploymentActivityTracker {
	updateDeploymentActivity(deploymentName: string): Promise<void>;
}

export type ToolboxPersonalAgentTool = {
	name: string;
	connectorToolName: string;
	description: string;
	approvalRequired: boolean;
	inputSchema: Record<string, unknown>;
};

export type ToolboxPersonalAgentToolGroup = {
	connectorKey: "notion" | "google_workspace" | "shifu_toolbox";
	connectionRef: string;
	tools: ToolboxPersonalAgentTool[];
};

const TOOLBOX_PERSONAL_AGENT_TOOL_CATALOG: Record<
	ToolboxPersonalAgentToolGroup["connectorKey"],
	ToolboxPersonalAgentTool[]
> = {
	google_workspace: [
		{
			name: "google_workspace_drive_search",
			connectorToolName: "gws_drive_search",
			description:
				"Search Google Drive files available to the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
					limit: { type: "number" },
				},
				required: ["query"],
			},
		},
		{
			name: "google_workspace_docs_read",
			connectorToolName: "gws_docs_read",
			description:
				"Read a Google Docs document available to the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: { documentId: { type: "string" } },
				required: ["documentId"],
			},
		},
		{
			name: "google_workspace_docs_create",
			connectorToolName: "gws_docs_create",
			description:
				"Create a Google Docs document as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
			},
		},
		{
			name: "google_workspace_docs_batch_update",
			connectorToolName: "gws_docs_batch_update",
			description: "Apply Google Docs API batchUpdate requests.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					documentId: { type: "string" },
					requests: { type: "array", items: { type: "object" } },
				},
				required: ["documentId", "requests"],
			},
		},
		{
			name: "google_workspace_sheets_read",
			connectorToolName: "gws_sheets_read",
			description: "Read values from a Google Sheets range.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string" },
					range: { type: "string" },
				},
				required: ["spreadsheetId", "range"],
			},
		},
		{
			name: "google_workspace_sheets_create",
			connectorToolName: "gws_sheets_create",
			description:
				"Create a Google Sheets spreadsheet as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
			},
		},
		{
			name: "google_workspace_sheets_values_update",
			connectorToolName: "gws_sheets_values_update",
			description: "Update values in a Google Sheets range.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string" },
					range: { type: "string" },
					values: {
						type: "array",
						items: { type: "array", items: {} },
					},
					valueInputOption: { type: "string", enum: ["RAW", "USER_ENTERED"] },
				},
				required: ["spreadsheetId", "range", "values"],
			},
		},
		{
			name: "google_workspace_sheets_batch_update",
			connectorToolName: "gws_sheets_batch_update",
			description: "Apply Google Sheets API batchUpdate requests.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					spreadsheetId: { type: "string" },
					requests: { type: "array", items: { type: "object" } },
				},
				required: ["spreadsheetId", "requests"],
			},
		},
		{
			name: "google_workspace_slides_read",
			connectorToolName: "gws_slides_read",
			description: "Read a Google Slides presentation.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: { presentationId: { type: "string" } },
				required: ["presentationId"],
			},
		},
		{
			name: "google_workspace_slides_create",
			connectorToolName: "gws_slides_create",
			description:
				"Create a Google Slides presentation as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: { title: { type: "string" } },
				required: ["title"],
			},
		},
		{
			name: "google_workspace_slides_batch_update",
			connectorToolName: "gws_slides_batch_update",
			description: "Apply Google Slides API batchUpdate requests.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					presentationId: { type: "string" },
					requests: { type: "array", items: { type: "object" } },
				},
				required: ["presentationId", "requests"],
			},
		},
		{
			name: "google_workspace_calendar_events_list",
			connectorToolName: "gws_calendar_events_list",
			description: "List Google Calendar events for the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					calendarId: { type: "string" },
					timeMin: { type: "string" },
					timeMax: { type: "string" },
					maxResults: { type: "number" },
					query: { type: "string" },
					pageToken: { type: "string" },
				},
			},
		},
		{
			name: "google_workspace_calendar_events_create",
			connectorToolName: "gws_calendar_events_create",
			description:
				"Create a Google Calendar event as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					calendarId: { type: "string" },
					summary: { type: "string" },
					description: { type: "string" },
					location: { type: "string" },
					startDateTime: { type: "string" },
					endDateTime: { type: "string" },
					timeZone: { type: "string" },
					attendees: { type: "array", items: { type: "string" } },
					sendUpdates: {
						type: "string",
						enum: ["all", "externalOnly", "none"],
					},
				},
				required: ["summary", "startDateTime", "endDateTime"],
			},
		},
		{
			name: "google_workspace_calendar_events_update",
			connectorToolName: "gws_calendar_events_update",
			description:
				"Update a Google Calendar event as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					calendarId: { type: "string" },
					eventId: { type: "string" },
					summary: { type: "string" },
					description: { type: "string" },
					location: { type: "string" },
					startDateTime: { type: "string" },
					endDateTime: { type: "string" },
					timeZone: { type: "string" },
					attendees: { type: "array", items: { type: "string" } },
					sendUpdates: {
						type: "string",
						enum: ["all", "externalOnly", "none"],
					},
				},
				required: ["eventId"],
			},
		},
		{
			name: "google_workspace_calendar_events_delete",
			connectorToolName: "gws_calendar_events_delete",
			description:
				"Delete a Google Calendar event as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					calendarId: { type: "string" },
					eventId: { type: "string" },
					sendUpdates: {
						type: "string",
						enum: ["all", "externalOnly", "none"],
					},
				},
				required: ["eventId"],
			},
		},
		{
			name: "google_workspace_chat_spaces_list",
			connectorToolName: "gws_chat_spaces_list",
			description:
				"List Google Chat spaces visible to the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					pageSize: { type: "number" },
					pageToken: { type: "string" },
					filter: { type: "string" },
				},
			},
		},
		{
			name: "google_workspace_chat_messages_list",
			connectorToolName: "gws_chat_messages_list",
			description: "Read messages from a Google Chat space.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					parent: { type: "string" },
					pageSize: { type: "number" },
					pageToken: { type: "string" },
					filter: { type: "string" },
					orderBy: { type: "string" },
				},
				required: ["parent"],
			},
		},
		{
			name: "google_workspace_chat_messages_create",
			connectorToolName: "gws_chat_messages_create",
			description: "Send a Google Chat message as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					parent: { type: "string" },
					text: { type: "string" },
					threadKey: { type: "string" },
				},
				required: ["parent", "text"],
			},
		},
	],
	notion: [
		{
			name: "notion_search",
			connectorToolName: "notion-search",
			description:
				"Search Notion pages and databases available to the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
					limit: { type: "number" },
				},
				required: ["query"],
			},
		},
		{
			name: "notion_create_pages",
			connectorToolName: "notion-create-pages",
			description: "Create Notion pages as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					parent: { type: "object" },
					pages: { type: "array", items: { type: "object" } },
				},
				required: ["parent", "pages"],
			},
		},
		{
			name: "notion_update_page",
			connectorToolName: "notion-update-page",
			description: "Update a Notion page as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					page_id: { type: "string" },
					properties: { type: "object" },
					archived: { type: "boolean" },
				},
				required: ["page_id"],
			},
		},
		{
			name: "notion_create_comment",
			connectorToolName: "notion-create-comment",
			description: "Create a Notion comment as the connected Toolbox user.",
			approvalRequired: true,
			inputSchema: {
				type: "object",
				properties: {
					parent: { type: "object" },
					rich_text: { type: "array", items: { type: "object" } },
				},
				required: ["parent", "rich_text"],
			},
		},
	],
	shifu_toolbox: [
		{
			name: "meeting_search",
			connectorToolName: "meeting_search",
			description:
				"Search meeting records available to the connected Toolbox user.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
					limit: { type: "number" },
				},
				required: ["query"],
			},
		},
		{
			name: "submit_course_pm_profile",
			connectorToolName: "submit_course_pm_profile",
			description:
				"Submit or update the connected Toolbox user's course PM onboarding profile after the required course context has been collected.",
			approvalRequired: false,
			inputSchema: {
				type: "object",
				properties: {
					payloadKind: { type: "string" },
					pmDisplayName: { type: "string" },
					courses: { type: "array", items: { type: "object" } },
				},
				required: ["payloadKind", "courses"],
			},
		},
	],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportedToolboxPersonalAgentConnector(
	value: unknown,
): value is ToolboxPersonalAgentToolGroup["connectorKey"] {
	return (
		value === "notion" ||
		value === "google_workspace" ||
		value === "shifu_toolbox"
	);
}

type ToolboxPersonalAgentToolCallRequest = {
	connectorKey?: unknown;
	connectionRef?: unknown;
	connectorToolName?: unknown;
	args?: unknown;
};

type ToolboxPersonalAgentToolExecutionResult = {
	status?: "executed" | "blocked-notified" | "blocked-no-channel";
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
	diagnosticCode?: string;
};

type ToolboxPersonalAgentMcpProxy = {
	executeToolDirect?: McpProxy["executeToolDirect"];
	callToolWithApproval?: (
		agentId: string,
		userId: string,
		mcpId: string,
		toolName: string,
		args: Record<string, unknown>,
		tokenContext?: {
			token?: string;
			channelId?: string;
			conversationId?: string;
			organizationId?: string;
			messageId?: string;
			processedMessageIds?: string[];
			connectionId?: string;
			teamId?: string;
			platform?: string;
		},
	) => Promise<ToolboxPersonalAgentToolExecutionResult>;
};

function safeToolboxPersonalAgentToolError(
	errorCode: string,
	errorMessage: string,
	diagnosticCode?: string,
) {
	return {
		ok: false,
		content: null,
		errorCode,
		errorMessage,
		...(diagnosticCode ? { diagnosticCode } : {}),
	};
}

const SAFE_TOOLBOX_PERSONAL_AGENT_TOOL_DIAGNOSTIC_CODES = new Set([
	"oauth_scope_denied",
	"oauth_refresh_failed",
	"upstream_unauthorized",
	"upstream_forbidden",
	"upstream_rate_limited",
	"tool_schema_invalid",
	"connector_unavailable",
	"tool_not_found",
]);

function safeToolboxPersonalAgentToolDiagnosticCode(
	value: unknown,
): string | undefined {
	return typeof value === "string" &&
		SAFE_TOOLBOX_PERSONAL_AGENT_TOOL_DIAGNOSTIC_CODES.has(value)
		? value
		: undefined;
}

function isToolboxPersonalAgentConnectorToolAllowed(
	connectorKey: ToolboxPersonalAgentToolGroup["connectorKey"],
	connectorToolName: string,
): boolean {
	return TOOLBOX_PERSONAL_AGENT_TOOL_CATALOG[connectorKey].some(
		(tool) => tool.connectorToolName === connectorToolName,
	);
}

function mcpIdForToolboxPersonalAgentConnection(
	connection: StoredConnection,
	fallbackConnectorKey: string,
): string {
	const metadata = isPlainRecord(connection.metadata) ? connection.metadata : {};
	const mcpId = metadata.mcpId;
	return typeof mcpId === "string" && mcpId.trim()
		? mcpId.trim()
		: fallbackConnectorKey;
}

/**
 * Worker Gateway - SSE and HTTP endpoints for worker communication
 * Workers connect via SSE to receive jobs, send responses via HTTP POST
 * Uses encrypted tokens for authentication and routing
 */
export class WorkerGateway {
	private app: Hono;
	private connectionManager: WorkerConnectionManager;
	private jobRouter: WorkerJobRouter;
	private queue: IMessageQueue;
	private mcpConfigService: McpConfigService;
	private instructionService: InstructionService;
	private publicGatewayUrl: string;
	private mcpProxy?: McpProxy;
	private providerCatalogService?: ProviderCatalogService;
	private agentSettingsStore?: AgentSettingsStore;
	private secretStore?: WritableSecretStore;
	private agentConnectionStore: AgentConnectionStore;
	private deploymentActivityTracker?: DeploymentActivityTracker;

	constructor(
		queue: IMessageQueue,
		publicGatewayUrl: string,
		mcpConfigService: McpConfigService,
		instructionService: InstructionService,
		mcpProxy?: McpProxy,
		providerCatalogService?: ProviderCatalogService,
		agentSettingsStore?: AgentSettingsStore,
		secretStore?: WritableSecretStore,
		agentConnectionStore: AgentConnectionStore = createPostgresAgentConnectionStore(),
	) {
		this.queue = queue;
		this.publicGatewayUrl = publicGatewayUrl;
		this.connectionManager = new WorkerConnectionManager();
		this.jobRouter = new WorkerJobRouter(queue, this.connectionManager);
		this.mcpConfigService = mcpConfigService;
		this.instructionService = instructionService;
		this.mcpProxy = mcpProxy;
		this.providerCatalogService = providerCatalogService;
		this.agentSettingsStore = agentSettingsStore;
		this.secretStore = secretStore;
		this.agentConnectionStore = agentConnectionStore;

		// Setup Hono app
		this.app = new Hono();
		this.setupRoutes();
	}

	/**
	 * Get the Hono app
	 */
	getApp(): Hono {
		return this.app;
	}

	/**
	 * Get the connection manager (for sending SSE notifications from external routes)
	 */
	getConnectionManager(): WorkerConnectionManager {
		return this.connectionManager;
	}

	setDeploymentActivityTracker(tracker: DeploymentActivityTracker): void {
		this.deploymentActivityTracker = tracker;
	}

	/**
	 * Setup routes on Hono app
	 */
	private setupRoutes() {
		// SSE endpoint for workers to receive jobs
		// Routes are mounted at /worker, so paths here should be relative
		this.app.get("/stream", (c) => this.handleStreamConnection(c));

		// HTTP POST endpoint for workers to send responses
		this.app.post("/response", (c) => this.handleWorkerResponse(c));

		// Unified session context endpoint (includes MCP + instructions)
		this.app.get("/session-context", (c) =>
			this.handleSessionContextRequest(c),
		);

		this.app.post("/internal/toolbox-personal-agent-tools/call", (c) =>
			this.handleToolboxPersonalAgentToolCall(c),
		);

		// Per-run transcript snapshots — backs the multi-replica unblock.
		// Workers hydrate from the latest completed snapshot on boot and POST
		// a new snapshot on every terminal state. The routes themselves are
		// always mounted (gated by the JWT scope check inside).
			this.app.route("/transcript", createTranscriptRoutes());

			this.app.route("", createExecutionEventRoutes());
			this.app.route("", createExecutionTaskStatusRoutes());

			logger.debug("Worker gateway routes registered");
	}

	private async enrichMcpStatus(
		mcpStatus: Array<{
			id: string;
			name: string;
			requiresAuth: boolean;
			requiresInput: boolean;
		}>,
		agentId: string,
		userId: string,
	): Promise<
		Array<{
			id: string;
			name: string;
			requiresAuth: boolean;
			requiresInput: boolean;
			authenticated: boolean;
			configured: boolean;
		}>
	> {
		const secretStore = this.secretStore;
		if (!secretStore || !agentId || !userId) {
			return mcpStatus.map((mcp) => ({
				...mcp,
				authenticated: false,
				configured: !mcp.requiresInput,
			}));
		}

		return Promise.all(
			mcpStatus.map(async (mcp) => {
				if (!mcp.requiresAuth) {
					return {
						...mcp,
						authenticated: false,
						configured: !mcp.requiresInput,
					};
				}

				let credential: Awaited<ReturnType<typeof getStoredCredential>> = null;
				try {
					credential = await getStoredCredential(
						secretStore,
						agentId,
						userId,
						mcp.id,
					);
				} catch (error) {
					logger.warn("Failed to look up stored MCP credential", {
						mcpId: mcp.id,
						agentId,
						userId,
						error: error instanceof Error ? error.message : String(error),
					});
				}

				return {
					...mcp,
					authenticated: !!credential,
					configured: !mcp.requiresInput,
				};
			}),
		);
	}

	private async collectToolboxPersonalAgentTools(params: {
		organizationId?: string;
		agentId?: string;
		ownerUserId?: string;
	}): Promise<ToolboxPersonalAgentToolGroup[]> {
		if (!params.organizationId || !params.agentId || !params.ownerUserId) {
			return [];
		}

		let connections: StoredConnection[];
		try {
			connections = await this.agentConnectionStore.listConnections({
				agentId: params.agentId,
			});
		} catch (error) {
			logger.warn("Failed to list materialized Toolbox MCP connections", {
				agentId: params.agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}

		return connections
			.flatMap((connection): ToolboxPersonalAgentToolGroup[] => {
				if (connection.organizationId !== params.organizationId) return [];
				if (connection.agentId !== params.agentId) return [];
				if (connection.status !== "active") return [];

				const metadata = isPlainRecord(connection.metadata)
					? connection.metadata
					: {};
				if (metadata.ownerUserId !== params.ownerUserId) return [];
				if (metadata.source !== "toolbox-personal-agent-materialized") {
					return [];
				}
				if (!supportedToolboxPersonalAgentConnector(metadata.connectorKey)) {
					return [];
				}

				return [
					{
						connectorKey: metadata.connectorKey,
						connectionRef: connection.id,
						tools: TOOLBOX_PERSONAL_AGENT_TOOL_CATALOG[
							metadata.connectorKey
						].map((tool) => ({ ...tool })),
					},
				];
			})
			.sort((a, b) =>
				`${a.connectorKey}:${a.connectionRef}`.localeCompare(
					`${b.connectorKey}:${b.connectionRef}`,
				),
			);
	}

	private async getReadyToolboxPersonalAgentConnection(params: {
		organizationId: string;
		agentId: string;
		ownerUserId: string;
		connectorKey: ToolboxPersonalAgentToolGroup["connectorKey"];
		connectionRef: string;
	}): Promise<StoredConnection | null> {
		let connection: StoredConnection | null;
		try {
			connection = await this.agentConnectionStore.getConnection(
				params.connectionRef,
			);
		} catch (error) {
			logger.warn("Failed to read materialized Toolbox MCP connection", {
				agentId: params.agentId,
				connectionRef: params.connectionRef,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		if (!connection) return null;
		if (connection.organizationId !== params.organizationId) return null;
		if (connection.agentId !== params.agentId) return null;
		if (connection.status !== "active") return null;

		const metadata = isPlainRecord(connection.metadata)
			? connection.metadata
			: {};
		if (metadata.ownerUserId !== params.ownerUserId) return null;
		if (metadata.source !== "toolbox-personal-agent-materialized") {
			return null;
		}
		if (metadata.connectorKey !== params.connectorKey) return null;
		return connection;
	}

	private async handleToolboxPersonalAgentToolCall(
		c: Context,
	): Promise<Response> {
		const auth = await this.authenticateWorker(c);
		if (!auth) {
			return c.json({ error: "Invalid worker token" }, 401);
		}

		const buildResponse = async (): Promise<Response> => {
			let body: ToolboxPersonalAgentToolCallRequest;
			try {
				body = await c.req.json<ToolboxPersonalAgentToolCallRequest>();
			} catch {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_invalid_request",
						"Invalid JSON body",
					),
					400,
				);
			}

			const connectionRef =
				typeof body.connectionRef === "string"
					? body.connectionRef.trim()
					: "";
			const connectorToolName =
				typeof body.connectorToolName === "string"
					? body.connectorToolName.trim()
					: "";
			const connectorKey = body.connectorKey;
			const args = body.args === undefined ? {} : body.args;
			const { userId, agentId, organizationId } = auth.tokenData;

			if (
				!userId ||
				!agentId ||
				!organizationId ||
				!connectionRef ||
				!connectorToolName ||
				!supportedToolboxPersonalAgentConnector(connectorKey) ||
				!isPlainRecord(args)
			) {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_invalid_request",
						"connectorKey, connectionRef, connectorToolName, object args, and worker identity are required",
					),
					400,
				);
			}

			if (
				!isToolboxPersonalAgentConnectorToolAllowed(
					connectorKey,
					connectorToolName,
				)
			) {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_tool_not_allowed",
						"MCP tool is not allowed for personal-agent execution",
					),
					200,
				);
			}

			const connection = await this.getReadyToolboxPersonalAgentConnection({
				organizationId,
				agentId,
				ownerUserId: userId,
				connectorKey,
				connectionRef,
			});
			if (!connection) {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_not_ready",
						"MCP connection is not ready",
					),
					200,
				);
			}

			const mcpProxy = this.mcpProxy as
				| ToolboxPersonalAgentMcpProxy
				| undefined;
			if (!mcpProxy?.callToolWithApproval && !mcpProxy?.executeToolDirect) {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_unavailable",
						"MCP execution is unavailable",
					),
					503,
				);
			}

			try {
				const mcpId = mcpIdForToolboxPersonalAgentConnection(
					connection,
					connectorKey,
				);
				const result: ToolboxPersonalAgentToolExecutionResult =
					mcpProxy.callToolWithApproval
						? await mcpProxy.callToolWithApproval(
								agentId,
								userId,
								mcpId,
								connectorToolName,
								args,
								{
									token: auth.token,
									channelId: auth.tokenData.channelId,
									conversationId: auth.tokenData.conversationId,
									organizationId: auth.tokenData.organizationId,
									messageId: auth.tokenData.messageId,
									processedMessageIds: auth.tokenData.processedMessageIds,
									connectionId: auth.tokenData.connectionId,
									teamId: auth.tokenData.teamId,
									platform: auth.tokenData.platform,
								},
							)
						: await mcpProxy.executeToolDirect!(
								agentId,
								userId,
								mcpId,
								connectorToolName,
								args,
							);
				if (
					result?.status === "blocked-notified" ||
					result?.status === "blocked-no-channel"
				) {
					return c.json(
						{
							...safeToolboxPersonalAgentToolError(
								"lobu_mcp_approval_required",
								"MCP tool call requires approval",
							),
							content: result.content ?? null,
						},
						200,
					);
				}
				if (result?.isError) {
					return c.json(
						safeToolboxPersonalAgentToolError(
							"lobu_mcp_tool_error",
							"MCP tool execution failed",
							safeToolboxPersonalAgentToolDiagnosticCode(
								result.diagnosticCode,
							),
						),
						200,
					);
				}
				return c.json({ ok: true, content: result?.content ?? null });
			} catch (error) {
				return c.json(
					safeToolboxPersonalAgentToolError(
						"lobu_mcp_tool_error",
						"MCP tool execution failed",
						safeToolboxPersonalAgentToolDiagnosticCode(
							error &&
								typeof error === "object" &&
								"diagnosticCode" in error
								? (error as { diagnosticCode?: unknown }).diagnosticCode
								: undefined,
						),
					),
					200,
				);
			}
		};

		if (auth.tokenData.organizationId) {
			return orgContext.run(
				{ organizationId: auth.tokenData.organizationId },
				buildResponse,
			);
		}

		return buildResponse();
	}

	/**
	 * Handle SSE connection from worker
	 */
	private async handleStreamConnection(c: Context): Promise<Response> {
		const auth = await this.authenticateWorker(c);
		if (!auth) {
			return c.json({ error: "Invalid token" }, 401);
		}

		const { deploymentName, userId, conversationId, agentId } =
			auth.tokenData as any;
		if (!conversationId) {
			return c.json({ error: "Invalid token (missing conversationId)" }, 401);
		}

		// Extract httpPort from query params (worker HTTP server registration)
		const httpPortParam = c.req.query("httpPort");
		const httpPort = httpPortParam ? parseInt(httpPortParam, 10) : undefined;

		// Create an SSE stream.
		//
		// Hono's `stream()` only fires `streamWriter.onAbort()` from
		// `ReadableStream.cancel()` — which doesn't run on abnormal disconnects
		// (LB idle timeout, intermediate proxy kill, worker pod hard exit). On
		// Node + current Bun the per-request `AbortSignal` is the only reliable
		// trigger. Without bridging it, a stale worker SSE leaks the writer
		// closure + `while !isClosed` loop until the 10-minute stale-cleanup
		// sweep catches up. Same retain pattern fixed for the invalidation
		// streams in #833. Refs #782.
		const requestSignal = c.req.raw.signal;

		return stream(c, async (streamWriter) => {
			let isClosed = false;

			// If the client already aborted between handler invocation and stream
			// body execution, bail out before registering anything.
			if (requestSignal?.aborted) {
				return;
			}

			// Create an SSE writer adapter
			const sseWriter: SSEWriter = {
				write: (data: string): boolean => {
					try {
						void streamWriter.write(data);
						return true;
					} catch {
						return false;
					}
				},
				end: () => {
					try {
						streamWriter.close();
					} catch {
						// Already closed
					}
				},
				onClose: (callback: () => void) => {
					streamWriter.onAbort(() => {
						isClosed = true;
						callback();
					});
				},
			};

			// Idempotent cleanup latch. The `onClose` subscriber must be registered
			// BEFORE the async pauseWorker/addConnection/registerWorker block so an
			// abort fired during that window can't leave a dead writer registered
			// in the connection manager. `connectionAdded` flips true the instant
			// we hand the writer to `addConnection`; the cleanup latch reads it and
			// either removes the registration (post-add) or no-ops (pre-add). The
			// `aborted` flag short-circuits the async setup so we don't even add a
			// dead writer.
			let connectionAdded = false;
			let cleanupRan = false;
			let aborted = false;
			const runCleanup = () => {
				if (cleanupRan) return;
				cleanupRan = true;
				aborted = true;
				if (!connectionAdded) {
					// Aborted before we registered; nothing to remove.
					return;
				}
				const current = this.connectionManager.getConnection(deploymentName);
				if (current && current.writer !== sseWriter) {
					logger.debug(
						`Ignoring stale disconnect for ${deploymentName} (replaced by newer SSE)`,
					);
					return;
				}
				this.jobRouter.pauseWorker(deploymentName).catch((err) => {
					logger.error(`Failed to pause worker ${deploymentName}:`, err);
				});
				this.connectionManager.removeConnection(deploymentName);
			};

			// Register the disconnect subscriber FIRST so an abort during the
			// async setup block below routes through the same idempotent latch.
			sseWriter.onClose(runCleanup);

			// Bridge per-request AbortSignal to the stream so abnormal disconnects
			// tear the writer down (Hono's onAbort alone doesn't fire on those).
			const detachAbortBridge = bindRequestAbortToStream(
				requestSignal,
				streamWriter,
			);

			// Set SSE headers
			c.header("Content-Type", "text/event-stream");
			c.header("Cache-Control", "no-cache");
			c.header("Connection", "keep-alive");
			c.header("X-Accel-Buffering", "no");

			// Clean up stale state before registering new connection.
			// When a container dies without cleanly closing its TCP socket,
			// the old SSE connection may still appear valid. Pause the BullMQ
			// worker first to prevent it from sending jobs to the dead connection,
			// then remove the stale connection so any in-flight handleJob will
			// fail and trigger a retry against the new connection.
			await this.jobRouter.pauseWorker(deploymentName);

			// If the request aborted during the await above, bail before touching
			// the connection manager. The cleanup latch already fired via the
			// abort bridge → onAbort → onClose path.
			if (aborted || requestSignal?.aborted) {
				detachAbortBridge();
				runCleanup();
				return;
			}

			if (this.connectionManager.isConnected(deploymentName)) {
				logger.info(
					`Cleaning up stale connection for ${deploymentName} before new SSE`,
				);
				// Intentionally no expectedWriter — always evict the old connection
				this.connectionManager.removeConnection(deploymentName);
			}

			// Register new (live) connection
			this.connectionManager.addConnection(
				deploymentName,
				userId,
				conversationId,
				agentId || "",
				sseWriter,
				httpPort,
			);
			connectionAdded = true;

			// If we lost the race — abort fired between the pre-check above and
			// here — drop the writer we just registered.
			if (aborted || requestSignal?.aborted) {
				detachAbortBridge();
				runCleanup();
				return;
			}

			// Register BullMQ worker (idempotent) and resume job processing
			await this.jobRouter.registerWorker(deploymentName);
			await this.jobRouter.resumeWorker(deploymentName);

			// Keep the connection open until the stream is actually aborted.
			try {
				while (!isClosed) {
					await streamWriter.sleep(1000);
				}
			} finally {
				detachAbortBridge();
			}
		});
	}

	/**
	 * Handle HTTP response from worker
	 */
	private async handleWorkerResponse(c: Context): Promise<Response> {
		const auth = await this.authenticateWorker(c);
		if (!auth) {
			return c.json({ error: "Invalid token" }, 401);
		}

		const { deploymentName } = auth.tokenData;

		// Update connection activity (SSE stale-cleanup clock).
		this.connectionManager.touchConnection(deploymentName);
		// Also refresh the deployment manager's idle clock. touchConnection()
		// only feeds the connection manager; idle cleanup reads deployment
		// lastActivity, which otherwise stays frozen at the last dispatch during
		// one long-running turn.
		void this.deploymentActivityTracker
			?.updateDeploymentActivity(deploymentName)
			.catch((error) => {
				logger.warn(
					`[WORKER-GATEWAY] Failed to refresh deployment activity for ${deploymentName}: ${error}`,
				);
			});

		try {
			const body = await c.req.json();
			const { jobId, ...responseData } = body;
			// Stamp the worker token's owning org onto the response so the row
			// landed in `thread_response` carries organization_id — the snapshot
			// ownership verifier in transcript-routes.ts denies POSTs to NULL-org
			// rows. The worker doesn't know its org (token-scoped, not payload-
			// scoped) so it relies on the gateway to inject it from the auth.
			const orgEnriched =
				auth.tokenData.organizationId && !responseData.organizationId
					? { ...responseData, organizationId: auth.tokenData.organizationId }
					: responseData;
			const enrichedResponse =
				auth.tokenData.connectionId &&
				(!orgEnriched.platformMetadata ||
					typeof orgEnriched.platformMetadata === "object")
					? {
							...orgEnriched,
							platformMetadata: {
								...(orgEnriched.platformMetadata || {}),
								connectionId: auth.tokenData.connectionId,
							},
						}
					: orgEnriched;

			// Acknowledge job completion if jobId provided
			if (jobId) {
				this.jobRouter.acknowledgeJob(jobId);
			}

			// Delivery receipts (worker ACKs) have no message payload — just acknowledge and return
			if (enrichedResponse.received) {
				if (enrichedResponse.heartbeat) {
					// touchConnection already ran above for all /worker/response calls,
					// keeping this worker alive in stale-cleanup.
					logger.debug(
						`[WORKER-GATEWAY] Received heartbeat ACK from ${deploymentName}`,
					);
				}
				// A worker ACK (delivery receipt or heartbeat) is a worker-driven
				// liveness signal — push the turn-liveness deadline forward so a live
				// but slow worker is never falsely failed by the sweep. Best-effort.
				void extendTurnDeadlines(deploymentName);
				return c.json({ success: true });
			}

			if (enrichedResponse.statusUpdate) {
				void extendTurnDeadlines(deploymentName);
			}

			// Log for debugging
			logger.info(
				`[WORKER-GATEWAY] Received response with fields: ${Object.keys(enrichedResponse).join(", ")}`,
			);
			if (enrichedResponse.delta) {
				logger.info(
					`[WORKER-GATEWAY] Stream delta: deltaLength=${enrichedResponse.delta.length}`,
				);
			}

			// Send response to thread_response queue. TERMINAL rows (success
			// completion via processedMessageIds, or error) are subject to the API
			// owner-gate in routeToRenderer — a non-owning replica re-queues them —
			// so they need the elevated retry budget to survive cross-pod hand-off.
			// Non-terminal deltas/status keep default options (not owner-gated).
			const isTerminalResponse = !!(
				enrichedResponse.error ||
				(Array.isArray(enrichedResponse.processedMessageIds) &&
					enrichedResponse.processedMessageIds.length > 0)
			);

			if (isTerminalResponse) {
				// The worker produced a real terminal reply (success or explicit
				// error). Persist the reply AND discharge the turn-liveness marker(s)
				// for the message(s) it processed in ONE transaction — so a pod crash
				// can't leave a surviving marker that the sweep would later turn into a
				// duplicate "worker stopped" error. The terminal row carries the
				// elevated retry budget (applied inside commitTerminalReply) so it
				// survives the owner-gate re-queue to the SSE-holding pod.
				const dischargeIds = new Set<string>();
				if (typeof enrichedResponse.messageId === "string") {
					dischargeIds.add(enrichedResponse.messageId);
				}
				for (const id of enrichedResponse.processedMessageIds ?? []) {
					if (typeof id === "string") dischargeIds.add(id);
				}
				await commitTerminalReply(
					deploymentName,
					[...dischargeIds],
					enrichedResponse,
					(enrichedResponse.organizationId as string | undefined) ?? null,
				);
			} else {
				// Non-terminal (delta / status): best-effort, not owner-gated.
				await this.queue.send("thread_response", enrichedResponse);
			}

			return c.json({ success: true });
		} catch (error) {
			logger.error(`Error handling worker response: ${error}`);
			return c.json({ error: "Failed to process response" }, 500);
		}
	}

	/**
	 * Unified session context endpoint
	 */
	private async handleSessionContextRequest(c: Context): Promise<Response> {
		if (!this.mcpConfigService || !this.instructionService) {
			return c.json({ error: "session_context_unavailable" }, 503);
		}

		const auth = await this.authenticateWorker(c);
		if (!auth) {
			return c.json({ error: "Invalid token" }, 401);
		}

		const buildContext = async (): Promise<Response> => {
			let shifuTrace: ShifuTraceContext | undefined;
			try {
				const {
					userId,
					platform,
					sessionKey,
					conversationId,
					agentId,
					deploymentName,
				} = auth.tokenData;
				const baseUrl = this.getRequestBaseUrl(c);
				if (!conversationId) {
					return c.json(
						{ error: "Invalid token (missing conversationId)" },
						401,
					);
				}
				shifuTrace = parseShifuTraceHeaders(
					c.req.raw.headers,
					"worker",
				);

				// Build instruction context
				const instructionContext: InstructionContext = {
					userId,
					agentId: agentId || "",
					sessionKey: sessionKey || "",
					workingDirectory: "/workspace",
					availableProjects: [],
				};

				// Build settings URL as a short-lived claim link so platform users
				// can open it without a pre-existing browser session.
				const CLAIM_TTL_MS = 10 * 60 * 1000; // 10 minutes
				const claimToken = encrypt(
					JSON.stringify({
						userId,
						platform: platform || "unknown",
						agentId: agentId || undefined,
						exp: Date.now() + CLAIM_TTL_MS,
					}),
				);
				const settingsUrl = new URL("/connect/claim", baseUrl);
				settingsUrl.searchParams.set("claim", claimToken);
				if (agentId) {
					settingsUrl.searchParams.set("agent", agentId);
				}

				// Fetch MCP config and session context in parallel
				const [mcpConfig, contextData] = await Promise.all([
					this.mcpConfigService.getWorkerConfig({
						baseUrl,
						workerToken: auth.token,
						deploymentName,
					}),
					this.instructionService.getSessionContext(
						platform || "unknown",
						instructionContext,
						{ settingsUrl: settingsUrl.toString() },
					),
				]);

				const enrichedMcpStatus = await this.enrichMcpStatus(
					contextData.mcpStatus,
					agentId || userId,
					userId,
				);
				const toolboxPersonalAgentTools =
					await this.collectToolboxPersonalAgentTools({
						organizationId: auth.tokenData.organizationId,
						agentId,
						ownerUserId: userId,
					});

				// Fetch tool lists and instructions for ALL MCPs (unauthenticated ones
				// will attempt discovery without credentials)
				const mcpTools: Record<string, McpTool[]> = {};
				const mcpInstructions: Record<string, string> = {};
				if (this.mcpProxy && enrichedMcpStatus.length > 0) {
					const toolResults = await Promise.allSettled(
						enrichedMcpStatus.map(async (mcp) => {
							const result = await this.mcpProxy?.fetchToolsForMcp(
								mcp.id,
								agentId || userId,
								auth.tokenData,
								auth.token,
								{ trace: shifuTrace },
							);
							return { mcpId: mcp.id, ...(result || { tools: [] }) };
						}),
					);

					for (const result of toolResults) {
						if (result.status === "fulfilled") {
							if (result.value.tools && result.value.tools.length > 0) {
								mcpTools[result.value.mcpId] = result.value.tools;
							}
							if (result.value.instructions) {
								mcpInstructions[result.value.mcpId] = result.value.instructions;
							}
						} else {
							logger.error("MCP tool fetch rejected", {
								reason:
									result.reason instanceof Error
										? result.reason.message
										: String(result.reason),
							});
						}
					}
				}

				// Resolve dynamic provider configuration
				const agentSettings =
					this.agentSettingsStore && agentId
						? await this.agentSettingsStore.getSettings(agentId)
						: null;
				const providerConfig = await this.resolveProviderConfig(
					agentId || "",
					resolveEffectiveModelRef(agentSettings),
					baseUrl,
					auth.token,
					auth.tokenData.organizationId,
				);

				// Fetch enabled skills with content for worker filesystem sync
				let skillsConfig: Array<{ name: string; content: string }> = [];
				const mcpContext: Record<string, string> = {};
				if (this.agentSettingsStore && agentId) {
					try {
						const settings = await this.agentSettingsStore.getSettings(agentId);
						const skills = settings?.skillsConfig?.skills || [];
						skillsConfig = skills
							.filter((s) => s.enabled && s.content)
							.map((s) => ({ name: s.name, content: s.content! }));
						// Build MCP context map: MCP server ID → skill instructions
						for (const skill of skills) {
							if (
								skill.enabled &&
								skill.instructions?.trim() &&
								skill.mcpServers?.length
							) {
								for (const mcp of skill.mcpServers) {
									mcpContext[mcp.id] = skill.instructions.trim();
								}
							}
						}
					} catch (error) {
						logger.error("Failed to fetch skills config for worker sync", {
							error,
						});
					}
				}

				const mergedSkillsInstructions = contextData.skillsInstructions || "";

				logger.info(
					`Session context for ${userId}: ${Object.keys(mcpConfig.mcpServers || {}).length} MCPs, ${contextData.agentInstructions.length} chars agent instructions, ${contextData.platformInstructions.length} chars platform instructions, ${contextData.networkInstructions.length} chars network instructions, ${mergedSkillsInstructions.length} chars skills instructions, ${enrichedMcpStatus.length} MCP status entries, ${Object.keys(mcpTools).length} MCP tool lists, ${Object.keys(mcpInstructions).length} MCP instructions, ${skillsConfig.length} skills, provider: ${providerConfig.defaultProvider || "none"}`,
				);

				void emitJourneyObsEvent({
					schema_version: "journey.trace.v1",
					trace_id: shifuTrace.traceId,
					journey_id: shifuTrace.journeyId,
					event: "lobu.session.created",
					service: "lobu",
					module: "gateway",
					status: "ok",
					agent: { id: agentId || "" },
					toolbox: { user_id: userId },
					session: { key: sessionKey || "" },
					conversation: { id: conversationId },
					mcp: {
						server_count: Object.keys(mcpConfig.mcpServers || {}).length,
						tools_list_count: Object.keys(mcpTools).length,
						status_count: enrichedMcpStatus.length,
					},
					provider: { default_provider: providerConfig.defaultProvider || "" },
				});

				return c.json({
					userId,
					agentId: agentId || "",
					mcpConfig,
					agentInstructions: contextData.agentInstructions,
					platformInstructions: contextData.platformInstructions,
					networkInstructions: contextData.networkInstructions,
					skillsInstructions: mergedSkillsInstructions,
					mcpStatus: enrichedMcpStatus,
					mcpTools,
					mcpInstructions,
					mcpContext,
					toolboxPersonalAgentTools,
					providerConfig,
					skillsConfig,
				});
			} catch (error) {
				logger.error("Failed to generate session context", { err: error });
				const trace =
					shifuTrace ?? parseShifuTraceHeaders(c.req.raw.headers, "worker");
				void emitJourneyObsEvent({
					schema_version: "journey.trace.v1",
					trace_id: trace.traceId,
					journey_id: trace.journeyId,
					event: "lobu.session.created",
					service: "lobu",
					module: "gateway",
					status: "failed",
					error: {
						name: error instanceof Error ? error.name : "Error",
						message: error instanceof Error ? error.message : String(error),
					},
				});
				return c.json({ error: "session_context_error" }, 500);
			}
		};

		if (auth.tokenData.organizationId) {
			return orgContext.run(
				{ organizationId: auth.tokenData.organizationId },
				buildContext,
			);
		}

		return buildContext();
	}

	private async authenticateWorker(
		c: Context,
	): Promise<{ tokenData: WorkerTokenData; token: string } | null> {
		const authHeader = c.req.header("authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return null;
		}

		const token = authHeader.substring(7);
		const tokenData = verifyWorkerToken(token);

		if (!tokenData) {
			logger.warn("Invalid token");
			return null;
		}

		if (
			tokenData.jti &&
			(await getRevokedTokenStore().isRevoked(tokenData.jti))
		) {
			logger.warn("Revoked worker token");
			return null;
		}

		return { tokenData, token };
	}

	private getRequestBaseUrl(c: Context): string {
		const forwardedProto = c.req.header("x-forwarded-proto");
		const protocolCandidate = Array.isArray(forwardedProto)
			? forwardedProto[0]
			: forwardedProto?.split(",")[0];
		const protocol = (protocolCandidate || "http").trim();
		const host = c.req.header("host");
		if (host) {
			// Preserve any base path from publicGatewayUrl (e.g. /lobu) when the
			// gateway is mounted as a sub-app under a prefix path.
			let basePath = "";
			try {
				basePath = new URL(this.publicGatewayUrl).pathname.replace(/\/$/, "");
			} catch {
				// publicGatewayUrl may not be a full URL in some configurations.
			}
			return `${protocol}://${host}${basePath}`;
		}
		return this.publicGatewayUrl;
	}

	/**
	 * Resolve dynamic provider configuration for a given agent.
	 * Mirrors the provider resolution logic in base-deployment-manager's
	 * generateEnvironmentVariables() but returns config values instead of env vars.
	 */
	private async resolveProviderConfig(
		agentId: string,
		agentModel?: string,
		requestBaseUrl?: string,
		workerToken?: string,
		organizationId?: string,
	): Promise<{
		credentialEnvVarName?: string;
		defaultProvider?: string;
		defaultProviderSlug?: string;
		defaultModel?: string;
		cliBackends?: Array<{
			providerId: string;
			name: string;
			command: string;
			args?: string[];
			env?: Record<string, string>;
			modelArg?: string;
			sessionArg?: string;
		}>;
		providerBaseUrlMappings?: Record<string, string>;
		configProviders?: Record<string, ConfigProviderMeta>;
	}> {
		if (!this.providerCatalogService || !agentId) {
			return {};
		}

		const effectiveProviders =
			await this.providerCatalogService.getInstalledModules(agentId);
		if (effectiveProviders.length === 0) {
			return {};
		}

		// Determine primary provider
		let primaryProvider = agentModel
			? await this.providerCatalogService.findProviderForModel(
					agentModel,
					effectiveProviders,
				)
			: undefined;

		if (!primaryProvider) {
			for (const candidate of effectiveProviders) {
				if (
					candidate.hasSystemKey() ||
					(await candidate.hasCredentials(agentId, { organizationId }))
				) {
					primaryProvider = candidate;
					break;
				}
			}
		}

		// Build proxy base URL mappings for all installed providers
		// Use the request base URL (the worker's DISPATCHER_URL) for internal routing
		const proxyBaseUrl = `${requestBaseUrl || this.publicGatewayUrl}/api/proxy`;
		const providerBaseUrlMappings: Record<string, string> = {};
		for (const provider of effectiveProviders) {
			Object.assign(
				providerBaseUrlMappings,
				provider.getProxyBaseUrlMappings(proxyBaseUrl, agentId),
			);
		}

		// Build CLI backend configs
		const cliBackends: Array<{
			providerId: string;
			name: string;
			command: string;
			args?: string[];
			env?: Record<string, string>;
			modelArg?: string;
			sessionArg?: string;
		}> = [];
		for (const provider of effectiveProviders) {
			const config = provider.getCliBackendConfig?.();
			if (config) {
				cliBackends.push({ providerId: provider.providerId, ...config });
			}
		}

		// Collect metadata from config-driven providers for worker model resolution
		const configProviders: Record<string, ConfigProviderMeta> = {};
		for (const provider of effectiveProviders) {
			const meta = (provider as ApiKeyProviderModule).getProviderMetadata?.();
			if (meta) {
				configProviders[provider.providerId] = meta;
			}
		}

		// Build credential placeholders for proxy mode — in-process workers need
		// these so the runtime doesn't reject requests before they reach the proxy.
		// Providers that authenticate via the worker JWT (e.g. Bedrock) receive
		// the worker token so their placeholder *is* a verifiable credential.
		const credentialPlaceholders: Record<string, string> = {};
		for (const provider of effectiveProviders) {
			if (
				provider.hasSystemKey() ||
				(await provider.hasCredentials(agentId, { organizationId }))
			) {
				const credVar = provider.getCredentialEnvVarName();
				const placeholder = provider.buildCredentialPlaceholder
					? await provider.buildCredentialPlaceholder(agentId, { workerToken })
					: "lobu-proxy";
				credentialPlaceholders[credVar] = placeholder;
			}
		}

		const result: {
			credentialEnvVarName?: string;
			defaultProvider?: string;
			defaultProviderSlug?: string;
			defaultModel?: string;
			cliBackends?: typeof cliBackends;
			providerBaseUrlMappings?: Record<string, string>;
			configProviders?: typeof configProviders;
			credentialPlaceholders?: Record<string, string>;
		} = {};

		if (primaryProvider) {
			result.credentialEnvVarName = primaryProvider.getCredentialEnvVarName();
			const upstream = primaryProvider.getUpstreamConfig?.();
			result.defaultProvider = upstream?.slug || primaryProvider.providerId;
			if (upstream?.slug && upstream.slug !== primaryProvider.providerId) {
				result.defaultProviderSlug = primaryProvider.providerId;
			}
		}

		if (agentModel) {
			result.defaultModel = agentModel;
		}

		if (Object.keys(providerBaseUrlMappings).length > 0) {
			result.providerBaseUrlMappings = providerBaseUrlMappings;
		}

		if (cliBackends.length > 0) {
			result.cliBackends = cliBackends;
		}

		if (Object.keys(configProviders).length > 0) {
			result.configProviders = configProviders;
		}

		if (Object.keys(credentialPlaceholders).length > 0) {
			result.credentialPlaceholders = credentialPlaceholders;
		}

		return result;
	}

	/**
	 * Shutdown gateway
	 */
	shutdown(): void {
		this.connectionManager.shutdown();
		this.jobRouter.shutdown();
	}
}
