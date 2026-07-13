import { type Context, Hono } from "hono";
import { getDb } from "../db/client.js";
import { getRuntimeInfo } from "../utils/runtime-info.js";
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
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const FIXED_WAKE_PROMPT =
	"Prepare the trusted scheduled course task using the attached structured course context.";

async function readBoundedJson(
	c: Context<{ Bindings: Env }>,
): Promise<unknown> {
	const declaredLength = Number(c.req.header("content-length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > MAX_REQUEST_BODY_BYTES
	) {
		throw new Error("request body is too large");
	}
	const body = await c.req.text();
	if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
		throw new Error("request body is too large");
	}
	return JSON.parse(body);
}

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

function requiredString(
	record: Record<string, unknown>,
	key: string,
	maxLength = 256,
): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${key} is required`);
	const trimmed = value.trim();
	if (trimmed.length > maxLength) throw new Error(`${key} is too long`);
	return trimmed;
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
	inspectConversationBinding: (input: {
		organizationId: string; ownerUserId: string; agentId: string;
	}) => Promise<{ conversationId: string; courseEntityId: string | null } | null>;
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
	const inspectBinding = options.inspectConversationBinding;
	const routes = new Hono<{ Bindings: Env }>();
	routes.get("/conversation-binding", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId) return c.json({ error: "Authentication required" }, 401);
		const ownerUserId = c.req.query("ownerUserId")?.trim();
		const agentId = c.req.query("agentId")?.trim();
		if (!ownerUserId || !agentId || !inspectBinding) return c.json({ error: "invalid_request" }, 400);
		const ownerRows = await getDb()`
			SELECT id FROM agents WHERE organization_id = ${organizationId} AND id = ${agentId}
			AND owner_platform = 'toolbox' AND owner_user_id = ${ownerUserId} LIMIT 1
		`;
		if (!ownerRows.length) return c.json({ error: "agent_owner_mismatch" }, 403);
		try {
			const binding = await inspectBinding({ organizationId, ownerUserId, agentId });
			if (!binding) return c.json({ error: "conversation_binding_not_found" }, 404);
			return c.json(binding, 200);
		} catch {
			return c.json({ error: "conversation_binding_inspect_failed" }, 500);
		}
	});
	routes.put("/", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId)
			return c.json({ error: "Authentication required" }, 401);

		let parsed: ParsedCourseWakeRequest;
		try {
			parsed = parseRequest(await readBoundedJson(c), organizationId);
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
					prompt: FIXED_WAKE_PROMPT,
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
	routes.get("/:engineRef/status", async (c) => {
		const denied = requireAdminPat(c);
		if (denied) return denied;
		const organizationId = c.get("organizationId") as string | null;
		if (!organizationId) return c.json({ error: "Authentication required" }, 401);
		const engineRef = c.req.param("engineRef")?.trim();
		const externalKey = c.req.query("externalKey")?.trim();
		const ownerUserId = c.req.query("ownerUserId")?.trim();
		const agentId = c.req.query("agentId")?.trim();
		if (!engineRef || !externalKey || !ownerUserId || !agentId ||
			!EXTERNAL_KEY_PATTERN.test(externalKey)) {
			return c.json({ error: "invalid_request" }, 400);
		}
		const rows = await getDb()<{
			id: string; external_key: string; paused: boolean; schedule_revision: number;
			next_run_at: Date; action_args: Record<string, unknown>;
		}>`
			SELECT id, external_key, paused, schedule_revision, next_run_at, action_args
			FROM scheduled_jobs
			WHERE id = ${engineRef} AND organization_id = ${organizationId}
			  AND external_key = ${externalKey} AND created_by_user = ${ownerUserId}
			  AND created_by_agent = ${agentId} AND action_type = 'wake_agent'
			  AND action_args->>'reason' = 'trusted-course-calendar-wake'
			  AND action_args->'trustedCourseWake'->>'source' = 'calendar_scheduled_wake'
			LIMIT 1
		`;
		const row = rows[0];
		if (!row) return c.json({ error: "course_wake_not_found" }, 404);
		const wake = row.action_args.trustedCourseWake as Record<string, unknown>;
		const scope = wake.trustedCourseScope as Record<string, unknown>;
		const eventRef = wake.calendarEventRef as Record<string, unknown>;
		const execution = row.action_args.courseWakeExecutionTrace as Record<string, unknown> | undefined;
		let runStatus: string | null = null;
		if (execution && Number.isSafeInteger(execution.runId) && Number(execution.runId) > 0) {
			const runRows = await getDb()<{ status: string }>`
				SELECT status FROM runs
				WHERE id = ${Number(execution.runId)}
				LIMIT 1
			`;
			runStatus = runRows[0]?.status ?? null;
		}
		return c.json({
			engineRef: row.id, externalKey: row.external_key, paused: row.paused,
			scheduleRevision: row.schedule_revision, nextRunAt: row.next_run_at.toISOString(),
			source: wake.source, automationId: wake.automationId,
			resolutionSource: scope.resolutionSource,
			courseEntityId: scope.courseEntityId, courseKey: scope.courseKey,
			scopeVersion: scope.scopeVersion, taskKind: wake.taskKind,
			eventStartAt: parseStrictRfc3339(eventRef.eventStartAt, "eventStartAt").toISOString(),
			scheduledFor: parseStrictRfc3339(wake.scheduledFor, "scheduledFor").toISOString(),
			fire: execution ? {
				status: execution.status, runId: execution.runId,
				conversationId: execution.conversationId,
				conversationBindingCourseEntityId: execution.conversationBindingCourseEntityId,
				courseEntityId: execution.courseEntityId,
				scopeVersion: execution.scopeVersion,
				contextVersion: execution.contextVersion,
				evidenceReadiness: execution.evidenceReadiness,
				runStatus,
			} : { status: "not_fired", runId: null },
			runtime: { service: "lobu-api", ...getRuntimeInfo() },
		});
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
			parsed = parseCancellationRequest(
				await readBoundedJson(c),
				organizationId,
			);
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
