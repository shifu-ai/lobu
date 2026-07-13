/**
 * Tool: manage_schedules
 *
 * User-facing CRUD over `scheduled_jobs`. Recurring or one-shot. Two
 * built-in action types out of the box:
 *
 *   - `send_notification` — at the scheduled time, run the notify-tool's
 *     server-side path: resolve recipients, insert event + targets.
 *     Same shape as the immediate `notify` tool, minus the synchronous
 *     in-line fire.
 *   - `wake_agent` — at the scheduled time, post a synthetic user message
 *     to an agent's thread. Lets an agent schedule its own follow-up
 *     ("wake me in an hour and check X") and survives crashes / deploys.
 *
 * Attribution is captured from the calling ToolContext: a user-driven
 * create stores `created_by_user`; an agent-driven create (via the
 * gateway's agent loop) gets `created_by_agent` set. The agent can later
 * list / pause its own schedules without holding extra state.
 */

import { type Static, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { Env } from '../../index';
import { routeAction } from './action-router';
import { getDb } from '../../db/client';
import {
  countActiveScheduledJobs,
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  pauseScheduledJob,
  resolveWakeAgentId,
  type ScheduledJobRow,
  upsertScheduledJobByExternalKeyWithQuota,
} from '../../scheduled/scheduled-jobs-service';
import type { ToolContext } from '../registry';
import logger from '../../utils/logger';
import { nextRunAt as nextCronTickAt } from '../../utils/cron';

// SHIFU FORK: member-scope-internal-tools plan, Task 3. Member-owned
// direct-auth sessions (see 1c52bc33) can reach this tool, but must be
// confined to their own agent / own notifications / a bounded quota — see
// `isPrivilegedRole` and the deps below.
const MEMBER_SCHEDULE_QUOTA = 20;

// ============================================
// Schema
// ============================================

const SendNotificationArgs = Type.Object({
  type: Type.Literal('send_notification'),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.Optional(Type.String({ maxLength: 1000 })),
  recipients: Type.Optional(
    Type.Union([
      Type.Literal('admins'),
      Type.Literal('all'),
      Type.Array(Type.String()),
    ])
  ),
  resource_url: Type.Optional(Type.String()),
});

const WakeAgentArgs = Type.Object({
  type: Type.Literal('wake_agent'),
  agent_id: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1, maxLength: 4000 }),
  thread_id: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String({ maxLength: 200 })),
});

const ActionUnion = Type.Union([SendNotificationArgs, WakeAgentArgs]);
const CreationKey = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });

const CreateAction = Type.Object({
  action: Type.Literal('create'),
  description: Type.String({ minLength: 1, maxLength: 200 }),
  creation_key: Type.Optional(CreationKey),
  /**
   * RFC3339 timestamp for the first (or only) firing. Required.
   * For one-shot schedules this is the only firing.
   */
  run_at: Type.String({
    description: "ISO timestamp for the first / only firing (e.g. '2026-05-15T09:00:00Z').",
  }),
  /**
   * Cron expression. When set, the job re-fires on this cron after
   * each firing. When omitted, the job is one-shot.
   */
  cron: Type.Optional(Type.String()),
  /** Handler-specific payload. The `type` field selects the handler. */
  payload: ActionUnion,
  /**
   * Optional source attribution — pass when the schedule was triggered
   * by another run / event / chat thread so the audit trail captures it.
   */
  source_run_id: Type.Optional(Type.Number()),
  source_event_id: Type.Optional(Type.Number()),
  source_thread_id: Type.Optional(Type.String()),
});

const ListAction = Type.Object({
  action: Type.Literal('list'),
  agent_id: Type.Optional(Type.String()),
  user_id: Type.Optional(Type.String()),
  action_type: Type.Optional(Type.String()),
  include_paused: Type.Optional(Type.Boolean()),
});

const PauseAction = Type.Object({
  action: Type.Literal('pause'),
  id: Type.String({ format: 'uuid' }),
  paused: Type.Optional(Type.Boolean({ default: true })),
});

const CancelAction = Type.Object({
  action: Type.Literal('cancel'),
  id: Type.String({ format: 'uuid' }),
});

/**
 * MCP-facing schema. Deliberately flat and union-free: the agent-worker's
 * schema projection strips union keywords (anyOf/oneOf) and quarantines
 * root-level unions, so models never see union shapes. Precise per-action
 * validation happens in the handlers, whose error messages document the
 * expected shape for model self-correction.
 */
export const ManageSchedulesSchema = Type.Object({
  action: Type.String({
    description: "One of 'create', 'list', 'pause', 'cancel'.",
  }),
  // create
  description: Type.Optional(Type.String({ maxLength: 200 })),
  creation_key: Type.Optional(CreationKey),
  run_at: Type.Optional(
    Type.String({
      description:
        "ISO timestamp for the first / only firing (must be in the future, e.g. '2026-05-15T09:00:00Z'). Optional when cron is set.",
    })
  ),
  cron: Type.Optional(
    Type.String({ description: 'Cron expression for recurring jobs. Omit for one-shot.' })
  ),
  payload: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "Handler payload. {type:'wake_agent', agent_id, prompt} or {type:'send_notification', title, body?, recipients?}.",
      }
    )
  ),
  // Flattened create fields — accepted as an alternative to payload.
  action_type: Type.Optional(
    Type.String({ description: "'wake_agent' or 'send_notification' (alternative to payload.type)." })
  ),
  agent_id: Type.Optional(
    Type.String({ description: 'wake_agent target agent id; also the list filter.' })
  ),
  prompt: Type.Optional(Type.String({ description: 'wake_agent prompt.' })),
  thread_id: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  title: Type.Optional(Type.String({ description: 'send_notification title.' })),
  body: Type.Optional(Type.String()),
  recipients: Type.Optional(Type.Unknown()),
  resource_url: Type.Optional(Type.String()),
  source_run_id: Type.Optional(Type.Number()),
  source_event_id: Type.Optional(Type.Number()),
  source_thread_id: Type.Optional(Type.String()),
  // list
  user_id: Type.Optional(Type.String()),
  include_paused: Type.Optional(Type.Boolean()),
  // pause / cancel
  id: Type.Optional(Type.String()),
  paused: Type.Optional(Type.Boolean()),
});

const InternalActionSchema = Type.Union([CreateAction, ListAction, PauseAction, CancelAction]);
type ManageSchedulesArgs = Static<typeof InternalActionSchema>;

const createValidator = TypeCompiler.Compile(CreateAction);

// ============================================
// Handler
// ============================================

interface ToolResult {
  schedule?: ReturnType<typeof serializeSchedule>;
  schedules?: Array<ReturnType<typeof serializeSchedule>>;
  ok?: boolean;
  error?: string;
}

function isPrivilegedRole(ctx: ToolContext): boolean {
  return ctx.memberRole === 'owner' || ctx.memberRole === 'admin';
}

/**
 * SHIFU FORK: dependency seam for the member-scoping logic below (Task 3).
 * Real callers get `defaultDeps` (real service functions + a real DB
 * ownership check); tests inject fakes without reaching for `mock.module`.
 */
export interface ManageSchedulesDeps {
  createScheduledJob: typeof createScheduledJob;
  upsertScheduledJobByExternalKeyWithQuota: typeof upsertScheduledJobByExternalKeyWithQuota;
  listScheduledJobs: typeof listScheduledJobs;
  getScheduledJob: typeof getScheduledJob;
  pauseScheduledJob: typeof pauseScheduledJob;
  deleteScheduledJob: typeof deleteScheduledJob;
  countActiveScheduledJobs: typeof countActiveScheduledJobs;
  /** True iff `agentId` is a `toolbox`-owned agent belonging to `userId` in `organizationId`. */
  agentOwnedByUser: (
    organizationId: string,
    userId: string | null,
    agentId: string
  ) => Promise<boolean>;
  /**
   * SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up. Resolve
   * a possibly-conversation-id-shaped `agent_id`
   * (`<agentId>_<userId>_<threadId>`) down to the bare `agents.id`. Returns
   * null when no agents row matches either form — callers must leave the raw
   * value untouched in that case (existing "unknown agent" behavior, not a
   * new error path).
   */
  resolveWakeAgentId: (organizationId: string, rawAgentId: string) => Promise<string | null>;
}

async function dbAgentOwnedByUser(
  organizationId: string,
  userId: string | null,
  agentId: string
): Promise<boolean> {
  if (!userId) return false;
  const sql = getDb();
  const rows = (await sql`
    SELECT 1 FROM agents
    WHERE id = ${agentId} AND organization_id = ${organizationId}
      AND owner_platform = 'toolbox' AND owner_user_id = ${userId}
    LIMIT 1
  `) as unknown as unknown[];
  return rows.length > 0;
}

async function dbResolveWakeAgentId(
  organizationId: string,
  rawAgentId: string
): Promise<string | null> {
  return resolveWakeAgentId(getDb(), organizationId, rawAgentId);
}

export const defaultManageSchedulesDeps: ManageSchedulesDeps = {
  createScheduledJob,
  upsertScheduledJobByExternalKeyWithQuota,
  listScheduledJobs,
  getScheduledJob,
  pauseScheduledJob,
  deleteScheduledJob,
  countActiveScheduledJobs,
  agentOwnedByUser: dbAgentOwnedByUser,
  resolveWakeAgentId: dbResolveWakeAgentId,
};

export async function manageSchedules(
  args: ManageSchedulesArgs,
  _env: Env,
  ctx: ToolContext,
  deps: ManageSchedulesDeps = defaultManageSchedulesDeps
): Promise<ToolResult> {
  return routeAction('manage_schedules', args.action, ctx, {
    create: () =>
      handleCreate(args as Extract<ManageSchedulesArgs, { action: 'create' }>, ctx, deps),
    list: () => handleList(args as Extract<ManageSchedulesArgs, { action: 'list' }>, ctx, deps),
    pause: () => handlePause(args as Extract<ManageSchedulesArgs, { action: 'pause' }>, ctx, deps),
    cancel: () =>
      handleCancel(args as Extract<ManageSchedulesArgs, { action: 'cancel' }>, ctx, deps),
  });
}

/**
 * MCP clients and models frequently serialize nested tool arguments as JSON
 * strings. Parse a stringified `payload` back to an object instead of failing
 * the union validation; non-JSON strings pass through so validation reports
 * the real error.
 */
export function coerceSchedulePayload(payload: unknown): unknown {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  return payload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WAKE_AGENT_FIELDS = ['agent_id', 'prompt', 'thread_id', 'reason'] as const;
const RESERVED_WAKE_TRUST_KEYS = new Set([
  'trustedcoursewake',
  'trustedcoursescope',
  'trustedcoursewakeprovenance',
  'trustedprovenance',
  'internaltrustedprovenance',
  'internaltrustedcoursewake',
  'internaltrustedcoursewakeprovenance',
]);
const NOTIFICATION_FIELDS = ['title', 'body', 'recipients', 'resource_url'] as const;

/**
 * Models flying blind on the projected schema flatten payload fields to the
 * top level or invent near-miss shapes. Assemble the canonical payload from
 * whatever arrived: parse string payloads, honour payload.type / action_type
 * aliases, and lift flattened fields into the payload.
 */
export function normalizeCreateArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const args = { ...raw };
  if (typeof args.creation_key === 'string') {
    args.creation_key = args.creation_key.trim();
  }
  const coerced = coerceSchedulePayload(args.payload);
  const payload: Record<string, unknown> = isPlainRecord(coerced) ? { ...coerced } : {};

  if (typeof payload.type !== 'string' || payload.type.length === 0) {
    const alias = [payload.action_type, args.action_type].find(
      (v): v is string => typeof v === 'string' && v.length > 0
    );
    if (alias) payload.type = alias;
  }
  delete payload.action_type;
  delete args.action_type;

  if (typeof payload.type !== 'string' || payload.type.length === 0) {
    if (typeof args.prompt === 'string' || typeof args.agent_id === 'string') {
      payload.type = 'wake_agent';
    } else if (typeof args.title === 'string') {
      payload.type = 'send_notification';
    }
  }

  if (payload.type === 'wake_agent') {
    for (const key of Object.keys(payload)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (RESERVED_WAKE_TRUST_KEYS.has(normalizedKey)) {
        delete payload[key];
      }
    }
  }

  const liftFields =
    payload.type === 'send_notification' ? NOTIFICATION_FIELDS : WAKE_AGENT_FIELDS;
  for (const field of liftFields) {
    if (payload[field] === undefined && args[field] !== undefined) {
      payload[field] = args[field];
    }
  }
  for (const field of [...WAKE_AGENT_FIELDS, ...NOTIFICATION_FIELDS]) {
    delete args[field];
  }

  // run_at omitted for a cron job: derive the first firing from the cron.
  if ((args.run_at === undefined || args.run_at === '') && typeof args.cron === 'string') {
    try {
      args.run_at = nextCronTickAt(args.cron);
    } catch {
      // leave run_at absent; validation reports the cron error below
    }
  }

  args.payload = payload;
  return args;
}

const CREATE_SHAPE_HINT =
  "Expected create shape: {action:'create', description, run_at:'<future ISO>', cron?, payload:{type:'wake_agent', agent_id, prompt} | {type:'send_notification', title, body?, recipients?}}. Flattened fields (action_type/agent_id/prompt/title/body) are also accepted in place of payload.";

async function handleCreate(
  rawArgs: Extract<ManageSchedulesArgs, { action: 'create' }>,
  ctx: ToolContext,
  deps: ManageSchedulesDeps
): Promise<ToolResult> {
  const args = normalizeCreateArgs(
    rawArgs as unknown as Record<string, unknown>
  ) as unknown as Extract<ManageSchedulesArgs, { action: 'create' }>;
  if (!createValidator.Check(args)) {
    const errs = [...createValidator.Errors(args)];
    return {
      error: `Invalid args: ${errs.map((e) => `${e.path} ${e.message}`).join('; ')}. ${CREATE_SHAPE_HINT}`,
    };
  }
  if (args.creation_key && !ctx.userId) {
    return { error: 'creation_key requires an authenticated user.' };
  }
  const runAtDate = new Date(args.run_at);
  if (Number.isNaN(runAtDate.getTime())) {
    return { error: `run_at is not a valid ISO timestamp: ${args.run_at}` };
  }
  // A stale timestamp usually means the model guessed the current time.
  // Return the server clock so it can self-correct on retry.
  if (runAtDate.getTime() < Date.now() - 30_000 && !args.cron) {
    return {
      error: `run_at is in the past. Current server time is ${new Date().toISOString()}; provide a future ISO timestamp.`,
    };
  }
  // If cron is set, sanity-check it by computing the next tick from now.
  if (args.cron) {
    try {
      nextCronTickAt(args.cron);
    } catch (err) {
      return {
        error: `cron expression rejected: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up.
  // Normalize a possibly-conversation-id-shaped `agent_id`
  // (`<agentId>_<userId>_<threadId>`) to the bare `agents.id` BEFORE the
  // ownership check below and before persisting. Production bug: an agent
  // scheduling its own wake via LINE doesn't know its bare id and sends the
  // full conversation id instead; the wake handler's exact-id lookup then
  // misses and the schedule silently auto-pauses (see jobs.ts). Running this
  // BEFORE the ownership check (rather than after) is deliberate: the check
  // must see the normalized id so (a) a member sending the conversation-id
  // form of their OWN agent isn't wrongly rejected, and (b) a member can't
  // bypass self-scoping by wrapping someone else's bare id inside a
  // conversation-id string — the ownership check below always evaluates the
  // resolved bare id, exactly as it would for the bare form. When
  // resolution finds no match at all (truly unknown agent), leave the raw
  // value untouched — existing "unknown agent" handling (ownership-check
  // failure for members; unchanged persist for privileged roles) applies
  // unmodified.
  if (args.payload.type === 'wake_agent') {
    const resolvedAgentId = await deps.resolveWakeAgentId(
      ctx.organizationId,
      args.payload.agent_id
    );
    if (resolvedAgentId) args.payload.agent_id = resolvedAgentId;
  }
  // SHIFU FORK: member self-scoping (member-scope-internal-tools plan, Task
  // 3). Members reach this tool only via a member-owned direct-auth session
  // (see 1c52bc33) — confine them to their own agent, their own
  // notification recipients, and a bounded active-schedule quota. Owner/admin
  // sessions are unrestricted.
  if (!isPrivilegedRole(ctx)) {
    if (args.payload.type === 'wake_agent') {
      const owned = await deps.agentOwnedByUser(
        ctx.organizationId,
        ctx.userId,
        args.payload.agent_id
      );
      if (!owned) {
        return { error: 'Members can only schedule wakes for agents they own.' };
      }
    }
    if (args.payload.type === 'send_notification') {
      const recipients = args.payload.recipients;
      if (recipients === 'all' || recipients === 'admins') {
        return { error: 'Members can only send scheduled notifications to themselves.' };
      }
      // Force the recipient list to the caller regardless of what was
      // requested — impossible to target another user via this path.
      args.payload.recipients = ctx.userId ? [ctx.userId] : recipients;
    }
    if (!args.creation_key) {
      const activeCount = await deps.countActiveScheduledJobs(ctx.organizationId, ctx.userId);
      if (activeCount >= MEMBER_SCHEDULE_QUOTA) {
        return {
          error: `Schedule quota reached (${MEMBER_SCHEDULE_QUOTA} active). Cancel unused schedules first. Current: ${activeCount}.`,
        };
      }
    }
  }

  // action_type comes from the payload's discriminant `type`.
  const actionType = args.payload.type;
  // Strip the discriminant before persisting — handlers know their own type.
  const { type: _omit, ...actionArgs } = args.payload as Record<string, unknown> & {
    type: string;
  };

  const createParams = {
    organizationId: ctx.organizationId,
    actionType,
    actionArgs,
    description: args.description,
    cron: args.cron ?? null,
    runAt: runAtDate,
    createdByUser: ctx.userId ?? null,
    // Attribution: any session with an agentId (member-owned direct-auth
    // sessions today; potentially the gateway agent loop in the future)
    // stamps created_by_agent. Resolves the prior TODO — this now applies
    // to all roles, not just members.
    createdByAgent: ctx.agentId ?? null,
    sourceRunId: args.source_run_id ?? null,
    sourceEventId: args.source_event_id ?? null,
    sourceThreadId: args.source_thread_id ?? null,
  };
  if (args.creation_key) {
    const outcome = await deps.upsertScheduledJobByExternalKeyWithQuota({
      ...createParams,
      externalKey: args.creation_key,
      changeDetection: 'full',
      activeQuota: isPrivilegedRole(ctx) ? undefined : MEMBER_SCHEDULE_QUOTA,
    });
    if (outcome.status === 'quota_exceeded') {
      return {
        error: `Schedule quota reached (${MEMBER_SCHEDULE_QUOTA} active). Cancel unused schedules first. Current: ${outcome.activeCount}.`,
      };
    }
    return { schedule: serializeSchedule(outcome.job) };
  }
  const job = await deps.createScheduledJob(createParams);
  return { schedule: serializeSchedule(job) };
}

async function handleList(
  args: Extract<ManageSchedulesArgs, { action: 'list' }>,
  ctx: ToolContext,
  deps: ManageSchedulesDeps
): Promise<ToolResult> {
  // SHIFU FORK: members can't list org-wide or spoof another user/agent via
  // args — force the filter to themselves regardless of what was passed.
  const privileged = isPrivilegedRole(ctx);
  const rows = await deps.listScheduledJobs({
    organizationId: ctx.organizationId,
    createdByAgent: privileged ? args.agent_id ?? null : null,
    createdByUser: privileged ? args.user_id ?? null : ctx.userId ?? null,
    actionType: args.action_type ?? null,
    includePaused: args.include_paused ?? true,
  });
  return { schedules: rows.map(serializeSchedule) };
}

/**
 * SHIFU FORK: a member may only pause/cancel a schedule they own — owned
 * meaning created_by_user or created_by_agent matches. Returns the same
 * not-found message as a truly missing id so the check can't be used to
 * probe for other users' schedule ids.
 */
function memberOwnsJob(job: ScheduledJobRow | null, ctx: ToolContext): boolean {
  if (!job) return false;
  // Null guards matter: a system-created job carries created_by_user AND
  // created_by_agent as null, and a ctx with a null userId/agentId would
  // otherwise "own" every such job via null === null.
  return (
    (job.created_by_user != null && job.created_by_user === ctx.userId) ||
    (job.created_by_agent != null && job.created_by_agent === ctx.agentId)
  );
}

async function handlePause(
  args: Extract<ManageSchedulesArgs, { action: 'pause' }>,
  ctx: ToolContext,
  deps: ManageSchedulesDeps
): Promise<ToolResult> {
  const notFound = { error: `Schedule '${args.id}' not found in this organization.` };
  if (!isPrivilegedRole(ctx)) {
    const existing = await deps.getScheduledJob(ctx.organizationId, args.id);
    if (!memberOwnsJob(existing, ctx)) return notFound;
  }
  const ok = await deps.pauseScheduledJob(ctx.organizationId, args.id, args.paused ?? true);
  if (!ok) return notFound;
  const job = await deps.getScheduledJob(ctx.organizationId, args.id);
  return { schedule: job ? serializeSchedule(job) : undefined, ok: true };
}

async function handleCancel(
  args: Extract<ManageSchedulesArgs, { action: 'cancel' }>,
  ctx: ToolContext,
  deps: ManageSchedulesDeps
): Promise<ToolResult> {
  const notFound = { error: `Schedule '${args.id}' not found in this organization.` };
  if (!isPrivilegedRole(ctx)) {
    const existing = await deps.getScheduledJob(ctx.organizationId, args.id);
    if (!memberOwnsJob(existing, ctx)) return notFound;
  }
  const ok = await deps.deleteScheduledJob(ctx.organizationId, args.id);
  if (!ok) return notFound;
  logger.info({ schedule_id: args.id, org: ctx.organizationId }, '[manage_schedules] cancelled');
  return { ok: true };
}

function serializeSchedule(row: ScheduledJobRow) {
  return {
    id: row.id,
    creation_key: row.external_key,
    organization_id: row.organization_id,
    action_type: row.action_type,
    action_args: row.action_args,
    cron: row.cron,
    next_run_at: row.next_run_at,
    last_fired_at: row.last_fired_at,
    last_fired_run_id: row.last_fired_run_id,
    paused: row.paused,
    description: row.description,
    created_by_user: row.created_by_user,
    created_by_agent: row.created_by_agent,
    source_run_id: row.source_run_id,
    source_event_id: row.source_event_id,
    source_thread_id: row.source_thread_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
