import { type Context, Hono } from "hono";
import { getDb } from "../db/client.js";
import type { Env } from "../index.js";
import {
	parseStrictRfc3339,
	parseTrustedCourseWakeV1,
	type TrustedCourseWakeV1,
} from "../scheduled/course-aware-wake.js";
import {
	cancelTrustedCourseWake,
	upsertScheduledJobByExternalKey,
} from "../scheduled/scheduled-jobs-service.js";

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

interface ParsedCourseWakeRequest {
	externalKey: string;
	ownerUserId: string;
	agentId: string;
	runAt: Date;
	payload: TrustedCourseWakeV1;
}

export interface CourseAwareWakeRoutesDeps {
	upsertScheduledJobByExternalKey: typeof upsertScheduledJobByExternalKey;
	cancelTrustedCourseWake: typeof cancelTrustedCourseWake;
}

interface ParsedCourseWakeCancellation {
	externalKey: string;
	ownerUserId: string;
	agentId: string;
}

function parseCancellationRequest(
	raw: unknown,
	organizationId: string,
): ParsedCourseWakeCancellation {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("body must be an object");
	}
	const body = raw as Record<string, unknown>;
	if (requiredString(body, "organizationId") !== organizationId) {
		throw new Error("organizationId mismatch");
	}
	const externalKey = requiredString(body, "externalKey");
	if (!EXTERNAL_KEY_PATTERN.test(externalKey)) {
		throw new Error("invalid externalKey");
	}
	return {
		externalKey,
		ownerUserId: requiredString(body, "ownerUserId"),
		agentId: requiredString(body, "agentId"),
	};
}

function parseRequest(
	raw: unknown,
	organizationId: string,
): ParsedCourseWakeRequest {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("body must be an object");
	}
	const body = raw as Record<string, unknown>;
	const requestedOrganizationId = requiredString(body, "organizationId");
	const ownerUserId = requiredString(body, "ownerUserId");
	const agentId = requiredString(body, "agentId");
	const externalKey = requiredString(body, "externalKey");
	if (requestedOrganizationId !== organizationId)
		throw new Error("organizationId mismatch");
	if (!EXTERNAL_KEY_PATTERN.test(externalKey))
		throw new Error("invalid externalKey");
	const runAt = parseStrictRfc3339(requiredString(body, "runAt"), "runAt");
	if (runAt.getTime() <= Date.now())
		throw new Error("runAt must be in the future");
	const payload = parseTrustedCourseWakeV1(body.payload, {
		ownerUserId,
		agentId,
	});
	const scheduledFor = parseStrictRfc3339(payload.scheduledFor, "scheduledFor");
	if (scheduledFor.getTime() !== runAt.getTime()) {
		throw new Error("runAt must match payload.scheduledFor");
	}
	return { externalKey, ownerUserId, agentId, runAt, payload };
}

export function createCourseAwareWakeRoutes(
	options: Partial<CourseAwareWakeRoutesDeps> = {},
): Hono<{ Bindings: Env }> {
	const upsert =
		options.upsertScheduledJobByExternalKey ?? upsertScheduledJobByExternalKey;
	const cancel = options.cancelTrustedCourseWake ?? cancelTrustedCourseWake;
	const routes = new Hono<{ Bindings: Env }>();
	routes.put("/", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId)
			return c.json({ error: "Authentication required" }, 401);

		let parsed: ParsedCourseWakeRequest;
		try {
			parsed = parseRequest(await c.req.json(), organizationId);
		} catch (error) {
			return c.json(
				{
					error: "invalid_request",
					message: error instanceof Error ? error.message : "invalid request",
				},
				400,
			);
		}

		try {
			const ownerRows = await getDb()`
        SELECT id FROM agents
        WHERE organization_id = ${organizationId}
          AND id = ${parsed.agentId}
          AND owner_platform = 'toolbox'
          AND owner_user_id = ${parsed.ownerUserId}
        LIMIT 1
      `;
			if (ownerRows.length === 0)
				return c.json({ error: "agent_owner_mismatch" }, 403);

			const job = await upsert({
				externalKey: parsed.externalKey,
				organizationId,
				actionType: "wake_agent",
				actionArgs: {
					agent_id: parsed.agentId,
					prompt: `Prepare the scheduled course task for ${parsed.payload.trustedCourseScope.courseDisplayName}.`,
					reason: "trusted-course-calendar-wake",
					trustedCourseWake: parsed.payload,
				},
				runAt: parsed.runAt,
				description: `Course calendar wake: ${parsed.payload.taskKind}`,
				createdByUser: parsed.ownerUserId,
				createdByAgent: parsed.agentId,
			});
			return c.json({ ok: true, engineRef: job.id }, 200);
		} catch {
			return c.json({ error: "course_wake_upsert_failed" }, 500);
		}
	});
	routes.delete("/:engineRef", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId)
			return c.json({ error: "Authentication required" }, 401);
		const engineRef = c.req.param("engineRef")?.trim();
		if (!engineRef || engineRef.length > 256) {
			return c.json(
				{ error: "invalid_request", message: "engineRef is required" },
				400,
			);
		}
		let parsed: ParsedCourseWakeCancellation;
		try {
			parsed = parseCancellationRequest(await c.req.json(), organizationId);
		} catch (error) {
			return c.json(
				{
					error: "invalid_request",
					message: error instanceof Error ? error.message : "invalid request",
				},
				400,
			);
		}
		try {
			const result = await cancel({ engineRef, organizationId, ...parsed });
			if (!result.found) return c.json({ error: "course_wake_not_found" }, 404);
			return c.json(
				{ cancelled: true, alreadyCancelled: result.alreadyCancelled },
				200,
			);
		} catch {
			return c.json({ error: "course_wake_cancel_failed" }, 500);
		}
	});
	return routes;
}

export const courseAwareWakeRoutes = createCourseAwareWakeRoutes();
