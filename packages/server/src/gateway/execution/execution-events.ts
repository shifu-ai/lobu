import { randomUUID } from "node:crypto";
import { getDb, type DbClient } from "../../db/client.js";

export type ExecutionTaskStatus =
  | "running"
  | "waiting_for_tool"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL_STATUSES = new Set<ExecutionTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const MAX_OBSERVABILITY_JSON_BYTES = 32 * 1024;

export interface ExecutionTask {
  id: string;
  agentId: string;
  sessionId: string | null;
  conversationId: string | null;
  userId: string | null;
  source: string;
  status: ExecutionTaskStatus;
  startedAt: string;
  lastEventAt: string;
  completedAt: string | null;
  finalSummary: unknown | null;
  error: unknown | null;
  metadata: Record<string, unknown>;
}

export interface ExecutionEvent {
  id: number;
  type: string;
  message: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionTaskStatusSnapshot extends ExecutionTask {
  /**
   * Recent events are returned oldest-first so polling clients can render or
   * replay them in display order without reversing the array.
   */
  events: ExecutionEvent[];
  hasMore: boolean;
  hasMoreEvents: boolean;
  eventsTruncated: boolean;
  nextCursor: number | null;
}

export interface CreateExecutionTaskInput {
  id?: string;
  agentId: string;
  sessionId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  source?: string;
  status?: ExecutionTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface RecordExecutionEventInput {
  taskId: string;
  type: string;
  message?: string | null;
  payload?: Record<string, unknown>;
  status?: ExecutionTaskStatus;
  finalSummary?: unknown;
  error?: unknown;
}

interface ExecutionTaskRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
  source: string;
  status: ExecutionTaskStatus;
  started_at: Date | string;
  last_event_at: Date | string;
  completed_at: Date | string | null;
  final_summary: unknown | null;
  error: unknown | null;
  metadata: Record<string, unknown> | null;
}

interface ExecutionEventRow {
  id: number;
  type: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value == null ? null : toIso(value);
}

function mapTaskRow(row: ExecutionTaskRow): ExecutionTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    source: row.source,
    status: row.status,
    startedAt: toIso(row.started_at),
    lastEventAt: toIso(row.last_event_at),
    completedAt: nullableIso(row.completed_at),
    finalSummary: row.final_summary,
    error: row.error,
    metadata: row.metadata ?? {},
  };
}

function mapEventRow(row: ExecutionEventRow): ExecutionEvent {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  };
}

function isTerminalStatus(status: ExecutionTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function jsonByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function boundedJson(value: unknown): unknown {
  const bytes = jsonByteLength(value);
  if (bytes == null) {
    return { truncated: true, unserializable: true };
  }
  if (bytes <= MAX_OBSERVABILITY_JSON_BYTES) {
    return value;
  }
  return { truncated: true, originalBytes: bytes };
}

function boundedPayload(
  value: Record<string, unknown> | undefined
): Record<string, unknown> {
  return boundedJson(value ?? {}) as Record<string, unknown>;
}

export async function createExecutionTask(
  input: CreateExecutionTaskInput,
  sql: DbClient = getDb()
): Promise<ExecutionTask> {
  const id = input.id ?? randomUUID();
  const rows = await sql<ExecutionTaskRow>`
    INSERT INTO public.execution_tasks (
      id,
      agent_id,
      session_id,
      conversation_id,
      user_id,
      source,
      status,
      metadata
    )
    VALUES (
      ${id},
      ${input.agentId},
      ${input.sessionId ?? null},
      ${input.conversationId ?? null},
      ${input.userId ?? null},
      ${input.source ?? "unknown"},
      ${input.status ?? "running"},
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;
  return mapTaskRow(rows[0]);
}

export async function updateExecutionTaskStatus(
  taskId: string,
  status: ExecutionTaskStatus,
  updates: { finalSummary?: unknown; error?: unknown } = {},
  sql: DbClient = getDb()
): Promise<ExecutionTask> {
  const completedAt = isTerminalStatus(status) ? new Date() : null;
  const statusIsTerminal = isTerminalStatus(status);
  const finalSummary =
    updates.finalSummary === undefined
      ? undefined
      : boundedJson(updates.finalSummary ?? null);
  const error =
    updates.error === undefined ? undefined : boundedJson(updates.error ?? null);
  const rows = await sql<ExecutionTaskRow>`
    UPDATE public.execution_tasks
    SET
      status = CASE
        WHEN status IN ('completed', 'failed', 'cancelled')
          AND ${statusIsTerminal}::boolean = false
          THEN status
        ELSE ${status}
      END,
      last_event_at = now(),
      completed_at = CASE
        WHEN status IN ('completed', 'failed', 'cancelled')
          AND ${statusIsTerminal}::boolean = false
          THEN completed_at
        WHEN ${completedAt}::timestamptz IS NULL THEN completed_at
        ELSE COALESCE(completed_at, ${completedAt}::timestamptz)
      END,
      final_summary = CASE
        WHEN status IN ('completed', 'failed', 'cancelled')
          AND ${statusIsTerminal}::boolean = false
          THEN final_summary
        WHEN ${finalSummary === undefined}::boolean THEN final_summary
        ELSE ${sql.json(finalSummary ?? null)}::jsonb
      END,
      error = CASE
        WHEN status IN ('completed', 'failed', 'cancelled')
          AND ${statusIsTerminal}::boolean = false
          THEN error
        WHEN ${error === undefined}::boolean THEN error
        ELSE ${sql.json(error ?? null)}::jsonb
      END
    WHERE id = ${taskId}
    RETURNING *
  `;
  if (!rows[0]) {
    throw new Error(`Execution task not found: ${taskId}`);
  }
  return mapTaskRow(rows[0]);
}

export async function recordExecutionEvent(
  input: RecordExecutionEventInput,
  sql: DbClient = getDb()
): Promise<ExecutionEvent> {
  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }>`
      SELECT id
      FROM public.execution_tasks
      WHERE id = ${input.taskId}
      FOR UPDATE
    `;
    if (!existing[0]) {
      throw new Error(`Execution task not found: ${input.taskId}`);
    }

    const eventRows = await tx<ExecutionEventRow>`
      INSERT INTO public.execution_events (
        task_id,
        type,
        message,
        payload
      )
      VALUES (
        ${input.taskId},
        ${input.type},
        ${input.message ?? null},
        ${tx.json(boundedPayload(input.payload))}
      )
      RETURNING id, type, message, payload, created_at
    `;

    if (input.status) {
      await updateExecutionTaskStatus(
        input.taskId,
        input.status,
        {
          finalSummary: input.finalSummary,
          error: input.error,
        },
        tx
      );
    } else {
      await tx`
        UPDATE public.execution_tasks
        SET last_event_at = now()
        WHERE id = ${input.taskId}
      `;
    }

    return mapEventRow(eventRows[0]);
  });
}

export async function getExecutionTaskStatus(
  taskId: string,
  options: { afterEventId?: number; limit?: number } = {},
  sql: DbClient = getDb()
): Promise<ExecutionTaskStatusSnapshot | null> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const taskRows = await sql<ExecutionTaskRow>`
    SELECT *
    FROM public.execution_tasks
    WHERE id = ${taskId}
    LIMIT 1
  `;
  if (!taskRows[0]) return null;

  let rawEventRows: ExecutionEventRow[];
  let eventsTruncated = false;

  if (options.afterEventId !== undefined) {
    rawEventRows = await sql<ExecutionEventRow>`
      SELECT id, type, message, payload, created_at
      FROM public.execution_events
      WHERE task_id = ${taskId}
        AND id > ${options.afterEventId}
      ORDER BY id ASC
      LIMIT ${limit + 1}
    `;
  } else {
    rawEventRows = await sql<ExecutionEventRow>`
      SELECT id, type, message, payload, created_at
      FROM (
        SELECT id, type, message, payload, created_at
        FROM public.execution_events
        WHERE task_id = ${taskId}
        ORDER BY id DESC
        LIMIT ${limit + 1}
      ) recent_events
      ORDER BY id ASC
    `;
    eventsTruncated = rawEventRows.length > limit;
  }

  const hasMoreEvents = rawEventRows.length > limit;
  const eventRows =
    options.afterEventId === undefined && hasMoreEvents
      ? rawEventRows.slice(1)
      : rawEventRows.slice(0, limit);

  return {
    ...mapTaskRow(taskRows[0]),
    events: eventRows.map(mapEventRow),
    hasMore: hasMoreEvents,
    hasMoreEvents,
    eventsTruncated,
    nextCursor: eventRows.at(-1)?.id ?? null,
  };
}
