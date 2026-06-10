/**
 * Toolbox/Gateway provisioning API for deterministic ShiFu user agents.
 *
 * This lives under the embedded `/lobu` app so it can use the same org-pinned
 * PAT path as LINE Gateway runtime calls. It intentionally exposes only a
 * narrow upsert surface: Toolbox supplies deterministic metadata/settings, and
 * Lobu stores them in the PAT's organization.
 */

import type { AgentSettings } from "@lobu/core";
import { type Context, Hono } from "hono";
import type { Env } from "../index";
import {
	AGENT_ID_PATTERN,
	createPostgresAgentConfigStore,
} from "./stores/postgres-stores";

export const provisioningRoutes = new Hono<{ Bindings: Env }>();

const SHIFU_USER_AGENT_ID_PATTERN = /^shifu-u-[a-z0-9-]+$/;

const configStore = createPostgresAgentConfigStore();

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
	if (
		!AGENT_ID_PATTERN.test(agentId) ||
		!SHIFU_USER_AGENT_ID_PATTERN.test(agentId)
	) {
		return c.json(
			{
				error:
					"agentId must be a Lobu-safe ShiFu user agent id starting with shifu-u-",
			},
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
	await configStore.saveMetadata(agentId, {
		agentId,
		name,
		description,
		owner: { platform: "toolbox", userId: user.id },
		organizationId,
		isWorkspaceAgent: false,
		createdAt: existing?.createdAt ?? Date.now(),
		lastUsedAt: existing?.lastUsedAt,
	});
	await configStore.saveSettings(agentId, { ...settings, updatedAt: Date.now() });

	return c.json(
		{
			ok: true,
			agentId,
			created,
			revisionRef: `lobu:${agentId}`,
		},
		created ? 201 : 200,
	);
});
