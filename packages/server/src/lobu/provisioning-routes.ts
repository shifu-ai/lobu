/**
 * Toolbox/Gateway provisioning API for deterministic ShiFu user agents.
 *
 * This lives under the embedded `/lobu` app so it can use the same org-pinned
 * PAT path as LINE Gateway runtime calls. It intentionally exposes only a
 * narrow upsert surface: Toolbox supplies deterministic metadata/settings, and
 * Lobu stores them in the PAT's organization.
 */

import { createHash } from "node:crypto";
import type { AgentSettings, StoredConnection } from "@lobu/core";
import { type Context, Hono } from "hono";
import { getDb } from "../db/client.js";
import type { McpConfigService } from "../gateway/auth/mcp/config-service.js";
import { startAuthCodeFlow } from "../gateway/auth/mcp/oauth-flow.js";
import { GrantStore } from "../gateway/permissions/grant-store.js";
import {
	getStoredCredential,
	refreshCredential,
} from "../gateway/routes/internal/device-auth.js";
import type { WritableSecretStore } from "../gateway/secrets/index.js";
import type { Env } from "../index";
import {
	validateExpectedGrantPatterns,
	verifyRuntimeGrantPatterns,
} from "./runtime-grant-verifier.js";
import {
	AGENT_ID_PATTERN,
	createPostgresAgentConfigStore,
	createPostgresAgentConnectionStore,
} from "./stores/postgres-stores";

const SHIFU_USER_AGENT_ID_PATTERN = /^shifu-u-[a-z0-9-]+$/;
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const configStore = createPostgresAgentConfigStore();
const connectionStore = createPostgresAgentConnectionStore();
const grantStore = new GrantStore();

interface ProvisioningRoutesOptions {
	mcpConfigService?: McpConfigService;
	secretStore?: WritableSecretStore;
	publicGatewayUrl?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireAdminPat(c: Context<{ Bindings: Env }>): Response | null {
	const session = c.get("session") as { id?: string } | null;
	const authSource = c.get("authSource") as "pat" | "session" | "oauth" | null;
	const authInfo = c.get("mcpAuthInfo") as { scopes?: string[] } | null;
	const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

	if (
		authSource === "pat" &&
		session?.id?.startsWith("pat:") &&
		scopes.includes("mcp:admin")
	) {
		return null;
	}

	return c.json(
		{
			error: "forbidden",
			error_description:
				"Provisioning requires an organization-scoped PAT with mcp:admin scope.",
		},
		403,
	);
}

function validateSettings(settings: unknown): Omit<AgentSettings, "updatedAt"> {
	if (settings === undefined) return {};
	if (!isObject(settings)) {
		throw new Error("settings must be an object");
	}
	return settings as Omit<AgentSettings, "updatedAt">;
}

function validateShifuAgentId(agentId: string): string | null {
	if (
		!AGENT_ID_PATTERN.test(agentId) ||
		!SHIFU_USER_AGENT_ID_PATTERN.test(agentId)
	) {
		return "agentId must be a Lobu-safe ShiFu user agent id starting with shifu-u-";
	}
	return null;
}

function parseUserId(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

async function isOwnedByToolboxUser(
	agentId: string,
	userId: string,
): Promise<boolean> {
	const metadata = await configStore.getMetadata(agentId);
	return Boolean(metadata && metadata.owner?.userId === userId);
}

function deterministicProvisionedMcpConnectionRef(
	organizationId: string,
	userId: string,
	agentId: string,
	mcpId: string,
): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([organizationId, userId, agentId, mcpId]))
		.digest("hex");
	return `toolbox-mcp:${digest}`;
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

function deterministicToolboxOwnerEmail(
	organizationId: string,
	ownerUserId: string,
): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([organizationId, ownerUserId]))
		.digest("hex")
		.slice(0, 32);
	return `toolbox-owner-${digest}@toolbox.local`;
}

async function ensureToolboxOwnerMembership(
	organizationId: string,
	ownerUserId: string,
): Promise<{ ensured: true; role: string }> {
	const sql = getDb();
	await sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		VALUES (
			${ownerUserId},
			${ownerUserId},
			${deterministicToolboxOwnerEmail(organizationId, ownerUserId)},
			true,
			NOW(),
			NOW()
		)
		ON CONFLICT (id) DO NOTHING
	`;
	await sql`
		INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
		VALUES (
			${deterministicMembershipId(organizationId, ownerUserId)},
			${organizationId},
			${ownerUserId},
			'member',
			NOW()
		)
		ON CONFLICT ("organizationId", "userId") DO NOTHING
	`;

	const rows = await sql<{ role: string }>`
		SELECT role
		FROM "member"
		WHERE "organizationId" = ${organizationId}
		  AND "userId" = ${ownerUserId}
		LIMIT 1
	`;

	return { ensured: true, role: String(rows[0]?.role ?? "member") };
}

function redirectUri(publicGatewayUrl: string): string {
	return `${publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
}

async function ensureUsableOAuthCredential(
	secretStore: WritableSecretStore,
	agentId: string,
	userId: string,
	mcpId: string,
	credential: Awaited<ReturnType<typeof getStoredCredential>> | null,
): Promise<Awaited<ReturnType<typeof getStoredCredential>> | null> {
	if (!credential) return null;
	if (credential.expiresAt > Date.now() + OAUTH_EXPIRY_BUFFER_MS) {
		return credential;
	}
	if (!credential.refreshToken) return null;
	const refreshed = await refreshCredential(
		secretStore,
		agentId,
		userId,
		mcpId,
		credential,
	);
	return refreshed;
}

async function syncProvisioningAgentUsers(params: {
	organizationId: string;
	agentId: string;
	ownerUserId: string;
	patUserId: string;
}): Promise<void> {
	const sql = getDb();
	await sql.begin(async (tx) => {
		await tx`
			DELETE FROM agent_users
			WHERE organization_id = ${params.organizationId}
			  AND agent_id = ${params.agentId}
			  AND platform = 'toolbox'
			  AND user_id <> ${params.ownerUserId}
		`;
		await tx`
			INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
			VALUES
				(${params.organizationId}, ${params.agentId}, 'toolbox', ${params.ownerUserId}, NOW()),
				(${params.organizationId}, ${params.agentId}, 'external', ${params.patUserId}, NOW())
			ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
		`;
	});
}

async function syncProvisioningGrants(
	agentId: string,
	settings: Omit<AgentSettings, "updatedAt">,
	organizationId: string,
): Promise<void> {
	for (const domain of settings.networkConfig?.allowedDomains ?? []) {
		await grantStore.grant(agentId, domain, null, undefined, organizationId);
	}
	for (const pattern of settings.preApprovedTools ?? []) {
		await grantStore.grant(agentId, pattern, null, undefined, organizationId);
	}
}

export function createProvisioningRoutes(
	options: ProvisioningRoutesOptions = {},
): Hono<{ Bindings: Env }> {
	const provisioningRoutes = new Hono<{ Bindings: Env }>();

	provisioningRoutes.post("/agents", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;

		const user = c.get("user") as { id?: string } | null;
		const organizationId = c.get("organizationId") as string | null;
		if (!user?.id || !organizationId) {
			return c.json({ error: "Authentication required" }, 401);
		}

		let body: {
			agentId?: unknown;
			name?: unknown;
			description?: unknown;
			ownerUserId?: unknown;
			settings?: unknown;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const description =
			typeof body.description === "string" && body.description.trim()
				? body.description.trim()
				: undefined;

		if (!agentId || !name) {
			return c.json({ error: "agentId and name are required" }, 400);
		}
		const agentIdError = validateShifuAgentId(agentId);
		if (agentIdError) {
			return c.json({ error: agentIdError }, 400);
		}
		const ownerUserId =
			body.ownerUserId === undefined
				? user.id
				: typeof body.ownerUserId === "string"
					? body.ownerUserId.trim()
					: "";
		if (!ownerUserId) {
			return c.json(
				{ error: "ownerUserId must be a non-empty string when provided" },
				400,
			);
		}

		let settings: Omit<AgentSettings, "updatedAt">;
		try {
			settings = validateSettings(body.settings);
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "Invalid settings" },
				400,
			);
		}

		const existing = await configStore.getMetadata(agentId);
		const created = !existing;
		const membership = await ensureToolboxOwnerMembership(
			organizationId,
			ownerUserId,
		);
		await configStore.saveMetadata(agentId, {
			agentId,
			name,
			description,
			owner: { platform: "toolbox", userId: ownerUserId },
			organizationId,
			isWorkspaceAgent: false,
			createdAt: existing?.createdAt ?? Date.now(),
			lastUsedAt: existing?.lastUsedAt,
		});
		await configStore.saveSettings(agentId, {
			...settings,
			updatedAt: Date.now(),
		});
		await syncProvisioningAgentUsers({
			organizationId,
			agentId,
			ownerUserId,
			patUserId: user.id,
		});
		await syncProvisioningGrants(agentId, settings, organizationId);

		return c.json(
			{
				ok: true,
				agentId,
				created,
				membership,
				revisionRef: `lobu:${agentId}`,
			},
			created ? 201 : 200,
		);
	});

	provisioningRoutes.get("/agents/:agentId/settings", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;

		const agentId = c.req.param("agentId")?.trim() ?? "";
		const agentIdError = validateShifuAgentId(agentId);
		if (agentIdError) return c.json({ error: agentIdError }, 400);

		const settings = await configStore.getSettings(agentId);
		if (!settings) return c.json({ error: "Agent not found" }, 404);

		return c.json({
			ok: true,
			agentId,
			settings,
		});
	});

	provisioningRoutes.post(
		"/agents/:agentId/runtime-grants/verify",
		async (c) => {
			const denied = requireAdminPat(c);
			if (denied) return denied;

			const agentId = c.req.param("agentId")?.trim() ?? "";
			const agentIdError = validateShifuAgentId(agentId);
			if (agentIdError) return c.json({ error: agentIdError }, 400);

			let body: {
				userId?: unknown;
				revisionId?: unknown;
				expectedGrantPatterns?: unknown;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "invalid_json" }, 400);
			}

			const userId = parseUserId(body.userId);
			if (userId && !(await isOwnedByToolboxUser(agentId, userId))) {
				return c.json({ error: "agent_owner_mismatch" }, 404);
			}

			const revisionId =
				typeof body.revisionId === "string" && body.revisionId.trim()
					? body.revisionId.trim()
					: "runtime_grants";

			let expectedGrantPatterns: string[];
			try {
				expectedGrantPatterns = validateExpectedGrantPatterns(
					body.expectedGrantPatterns,
				);
			} catch (error) {
				return c.json(
					{
						ok: false,
						errorCode: "invalid_expected_grant_patterns",
						userVisibleSummary:
							error instanceof Error
								? error.message
								: "Invalid expected grant patterns",
					},
					400,
				);
			}

			const organizationId = c.get("organizationId") as string | null;
			if (!organizationId)
				return c.json({ error: "Authentication required" }, 401);

			const result = await verifyRuntimeGrantPatterns({
				grantStore,
				agentId,
				organizationId,
				revisionId,
				expectedGrantPatterns,
			});
			return c.json(result, 200);
		},
	);

	provisioningRoutes.post(
		"/agents/:agentId/mcp/:mcpId/oauth/start",
		async (c) => {
			const denied = requireAdminPat(c);
			if (denied) return denied;

			if (!options.mcpConfigService || !options.secretStore) {
				return c.json(
					{
						error: "oauth_unavailable",
						error_description:
							"MCP OAuth provisioning requires gateway OAuth services.",
					},
					503,
				);
			}

			const agentId = c.req.param("agentId")?.trim() ?? "";
			const mcpId = c.req.param("mcpId")?.trim() ?? "";
			const agentIdError = validateShifuAgentId(agentId);
			if (agentIdError) return c.json({ error: agentIdError }, 400);
			if (!mcpId) return c.json({ error: "mcpId is required" }, 400);

			let body: { userId?: unknown };
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "invalid_json" }, 400);
			}
			const userId = parseUserId(body.userId);
			if (!userId) return c.json({ error: "userId is required" }, 400);
			const organizationId = c.get("organizationId") as string | null;

			if (!(await isOwnedByToolboxUser(agentId, userId))) {
				return c.json({ error: "agent_owner_mismatch" }, 404);
			}

			const httpServer = await options.mcpConfigService.getHttpServer(
				mcpId,
				agentId,
			);
			if (!httpServer) {
				return c.json({ error: "mcp_not_found" }, 404);
			}

			const { authorizationUrl } = await startAuthCodeFlow({
				secretStore: options.secretStore,
				mcpId,
				upstreamUrl: httpServer.upstreamUrl,
				agentId,
				userId,
				scopeKey: userId,
				wwwAuthenticate: null,
				redirectUri: redirectUri(options.publicGatewayUrl ?? ""),
				staticOauth: httpServer.oauth,
				platform: "toolbox-web",
				channelId: "",
				conversationId: "",
				resumeMode: "none",
				organizationId: organizationId ?? undefined,
			});

			return c.json({
				ok: true,
				agentId,
				userId,
				mcpId,
				authorizationUrl,
			});
		},
	);

	provisioningRoutes.get(
		"/agents/:agentId/mcp/:mcpId/oauth/status",
		async (c) => {
			const denied = requireAdminPat(c);
			if (denied) return denied;

			if (!options.mcpConfigService || !options.secretStore) {
				return c.json(
					{
						error: "oauth_unavailable",
						error_description:
							"MCP OAuth provisioning requires gateway OAuth services.",
					},
					503,
				);
			}

			const agentId = c.req.param("agentId")?.trim() ?? "";
			const mcpId = c.req.param("mcpId")?.trim() ?? "";
			const userId = parseUserId(c.req.query("userId"));
			const agentIdError = validateShifuAgentId(agentId);
			if (agentIdError) return c.json({ error: agentIdError }, 400);
			if (!mcpId) return c.json({ error: "mcpId is required" }, 400);
			if (!userId) return c.json({ error: "userId is required" }, 400);

			if (!(await isOwnedByToolboxUser(agentId, userId))) {
				return c.json({ error: "agent_owner_mismatch" }, 404);
			}

			const httpServer = await options.mcpConfigService.getHttpServer(
				mcpId,
				agentId,
			);
			if (!httpServer) {
				return c.json({ error: "mcp_not_found" }, 404);
			}

			const credential = await getStoredCredential(
				options.secretStore,
				agentId,
				userId,
				mcpId,
			);
			const usableCredential = await ensureUsableOAuthCredential(
				options.secretStore,
				agentId,
				userId,
				mcpId,
				credential,
			);

			return c.json({
				ok: true,
				agentId,
				userId,
				mcpId,
				authenticated: !!usableCredential,
				...(usableCredential?.expiresAt
					? { expiresAt: usableCredential.expiresAt }
					: {}),
			});
		},
	);

	provisioningRoutes.post(
		"/agents/:agentId/mcp/:mcpId/oauth/materialize",
		async (c) => {
			const denied = requireAdminPat(c);
			if (denied) return denied;

			if (!options.mcpConfigService || !options.secretStore) {
				return c.json(
					{
						error: "oauth_unavailable",
						error_description:
							"MCP OAuth provisioning requires gateway OAuth services.",
					},
					503,
				);
			}

			const agentId = c.req.param("agentId")?.trim() ?? "";
			const mcpId = c.req.param("mcpId")?.trim() ?? "";
			const agentIdError = validateShifuAgentId(agentId);
			if (agentIdError) return c.json({ error: agentIdError }, 400);
			if (!mcpId) return c.json({ error: "mcpId is required" }, 400);

			let body: { userId?: unknown; connectorKey?: unknown };
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "invalid_json" }, 400);
			}
			const userId = parseUserId(body.userId);
			const connectorKey =
				typeof body.connectorKey === "string" && body.connectorKey.trim()
					? body.connectorKey.trim()
					: mcpId;
			if (!userId) return c.json({ error: "userId is required" }, 400);

			const organizationId = c.get("organizationId") as string | null;
			if (!organizationId) return c.json({ error: "Authentication required" }, 401);

			if (!(await isOwnedByToolboxUser(agentId, userId))) {
				return c.json({ error: "agent_owner_mismatch" }, 404);
			}

			const httpServer = await options.mcpConfigService.getHttpServer(
				mcpId,
				agentId,
			);
			if (!httpServer) {
				return c.json({ error: "mcp_not_found" }, 404);
			}

			const credential = await getStoredCredential(
				options.secretStore,
				agentId,
				userId,
				mcpId,
			);
			if (!credential) {
				return c.json({
					ok: true,
					agentId,
					userId,
					mcpId,
					status: "not_connected",
					lobuConnectionRef: null,
				});
			}
			if (!(await ensureUsableOAuthCredential(
				options.secretStore,
				agentId,
				userId,
				mcpId,
				credential,
			))) {
				return c.json({
					ok: true,
					agentId,
					userId,
					mcpId,
					status: "needs_reauth",
					lobuConnectionRef: null,
				});
			}

			const now = Date.now();
			const connectionRef = deterministicProvisionedMcpConnectionRef(
				organizationId,
				userId,
				agentId,
				mcpId,
			);
			const connection: StoredConnection = {
				id: connectionRef,
				organizationId,
				agentId,
				platform: connectorKey,
				config: {},
				settings: {},
				metadata: {
					ownerUserId: userId,
					connectorKey,
					provider: connectorKey,
					mcpId,
					source: "toolbox-personal-agent-materialized",
					authSource: "lobu_oauth",
				},
				status: "active",
				createdAt: now,
				updatedAt: now,
			};
			await connectionStore.saveConnection(connection);

			return c.json({
				ok: true,
				agentId,
				userId,
				mcpId,
				status: "ready",
				lobuConnectionRef: connectionRef,
			});
		},
	);

	return provisioningRoutes;
}

export const provisioningRoutes = createProvisioningRoutes();
