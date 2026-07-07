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
import {
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  pauseScheduledJob,
  type ScheduledJobRow,
} from '../../scheduled/scheduled-jobs-service';
import type { ToolContext } from '../registry';
import logger from '../../utils/logger';
import { nextRunAt as nextCronTickAt } from '../../utils/cron';

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

const CreateAction = Type.Object({
  action: Type.Literal('create'),
  description: Type.String({ minLength: 1, maxLength: 200 }),
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

export async function manageSchedules(
  args: ManageSchedulesArgs,
  _env: Env,
  ctx: ToolContext
): Promise<ToolResult> {
  return routeAction('manage_schedules', args.action, ctx, {
    create: () => handleCreate(args as Extract<ManageSchedulesArgs, { action: 'create' }>, ctx),
    list: () => handleList(args as Extract<ManageSchedulesArgs, { action: 'list' }>, ctx),
    pause: () => handlePause(args as Extract<ManageSchedulesArgs, { action: 'pause' }>, ctx),
    cancel: () => handleCancel(args as Extract<ManageSchedulesArgs, { action: 'cancel' }>, ctx),
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
const NOTIFICATION_FIELDS = ['title', 'body', 'recipients', 'resource_url'] as const;

/**
 * Models flying blind on the projected schema flatten payload fields to the
 * top level or invent near-miss shapes. Assemble the canonical payload from
 * whatever arrived: parse string payloads, honour payload.type / action_type
 * aliases, and lift flattened fields into the payload.
 */
export function normalizeCreateArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const args = { ...raw };
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
  ctx: ToolContext
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
  // action_type comes from the payload's discriminant `type`.
  const actionType = args.payload.type;
  // Strip the discriminant before persisting — handlers know their own type.
  const { type: _omit, ...actionArgs } = args.payload as Record<string, unknown> & {
    type: string;
  };

  const job = await createScheduledJob({
    organizationId: ctx.organizationId,
    actionType,
    actionArgs,
    description: args.description,
    cron: args.cron ?? null,
    runAt: runAtDate,
    createdByUser: ctx.userId ?? null,
    // ToolContext doesn't carry an agent attribution today; populated by
    // the gateway agent path when it lands (TODO once that wiring exists).
    createdByAgent: null,
    sourceRunId: args.source_run_id ?? null,
    sourceEventId: args.source_event_id ?? null,
    sourceThreadId: args.source_thread_id ?? null,
  });
  return { schedule: serializeSchedule(job) };
}

async function handleList(
  args: Extract<ManageSchedulesArgs, { action: 'list' }>,
  ctx: ToolContext
): Promise<ToolResult> {
  const rows = await listScheduledJobs({
    organizationId: ctx.organizationId,
    createdByAgent: args.agent_id ?? null,
    createdByUser: args.user_id ?? null,
    actionType: args.action_type ?? null,
    includePaused: args.include_paused ?? true,
  });
  return { schedules: rows.map(serializeSchedule) };
}

async function handlePause(
  args: Extract<ManageSchedulesArgs, { action: 'pause' }>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ok = await pauseScheduledJob(ctx.organizationId, args.id, args.paused ?? true);
  if (!ok) return { error: `Schedule '${args.id}' not found in this organization.` };
  const job = await getScheduledJob(ctx.organizationId, args.id);
  return { schedule: job ? serializeSchedule(job) : undefined, ok: true };
}

async function handleCancel(
  args: Extract<ManageSchedulesArgs, { action: 'cancel' }>,
  ctx: ToolContext
): Promise<ToolResult> {
  const ok = await deleteScheduledJob(ctx.organizationId, args.id);
  if (!ok) return { error: `Schedule '${args.id}' not found in this organization.` };
  logger.info({ schedule_id: args.id, org: ctx.organizationId }, '[manage_schedules] cancelled');
  return { ok: true };
}

function serializeSchedule(row: ScheduledJobRow) {
  return {
    id: row.id,
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
