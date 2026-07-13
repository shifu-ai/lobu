import { type Context, Hono } from "hono";
import { getDb } from "../db/client.js";
import type { Env } from "../index.js";
import { parseTrustedCourseWakeV1 } from "../scheduled/course-aware-wake.js";
import { upsertScheduledJobByExternalKey } from "../scheduled/scheduled-jobs-service.js";

const EXTERNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

function requireAdminPat(c: Context<{ Bindings: Env }>): Response | null {
	const session = c.get("session") as { id?: string } | null;
	const authSource = c.get("authSource") as string | null;
	const authInfo = c.get("mcpAuthInfo") as { scopes?: string[] } | null;
	if (
		authSource === "pat" &&
		session?.id?.startsWith("pat:") &&
		authInfo?.scopes?.includes("mcp:admin")
	)
		return null;
	return c.json(
		{
			error: "forbidden",
			error_description:
				"Course wake provisioning requires an organization-scoped PAT with mcp:admin scope.",
		},
		403,
	);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} is required`);
	return value.trim();
}

export function createCourseAwareWakeRoutes(): Hono<{ Bindings: Env }> {
	const routes = new Hono<{ Bindings: Env }>();
	routes.put("/", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId)
			return c.json({ error: "Authentication required" }, 401);

		try {
			const raw = await c.req.json();
			if (!raw || typeof raw !== "object" || Array.isArray(raw))
				throw new Error("body must be an object");
			const body = raw as Record<string, unknown>;
			const requestedOrganizationId = requiredString(body, "organizationId");
			const ownerUserId = requiredString(body, "ownerUserId");
			const agentId = requiredString(body, "agentId");
			const externalKey = requiredString(body, "externalKey");
			if (requestedOrganizationId !== organizationId)
				throw new Error("organizationId mismatch");
			if (!EXTERNAL_KEY_PATTERN.test(externalKey))
				throw new Error("invalid externalKey");
			const runAt = new Date(requiredString(body, "runAt"));
			if (!Number.isFinite(runAt.getTime())) throw new Error("invalid runAt");
			const payload = parseTrustedCourseWakeV1(body.payload, {
				ownerUserId,
				agentId,
			});

			const ownerRows = await getDb()`
        SELECT id FROM agents
        WHERE organization_id = ${organizationId}
          AND id = ${agentId}
          AND owner_platform = 'toolbox'
          AND owner_user_id = ${ownerUserId}
        LIMIT 1
      `;
			if (ownerRows.length === 0)
				return c.json({ error: "agent_owner_mismatch" }, 403);

			const job = await upsertScheduledJobByExternalKey({
				externalKey,
				organizationId,
				actionType: "wake_agent",
				actionArgs: {
					agent_id: agentId,
					prompt: `Prepare the scheduled course task for ${payload.trustedCourseScope.courseDisplayName}.`,
					reason: "trusted-course-calendar-wake",
					trustedCourseWake: payload,
				},
				runAt,
				description: `Course calendar wake: ${payload.taskKind}`,
				createdByUser: ownerUserId,
				createdByAgent: agentId,
			});
			return c.json({ ok: true, engineRef: job.id }, 200);
		} catch (error) {
			return c.json(
				{
					error: "invalid_request",
					message: error instanceof Error ? error.message : "invalid request",
				},
				400,
			);
		}
	});
	return routes;
}

export const courseAwareWakeRoutes = createCourseAwareWakeRoutes();
