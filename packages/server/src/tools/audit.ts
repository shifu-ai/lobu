import { createHash, randomUUID } from 'node:crypto';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { AUDIT_SEMANTIC_TYPE } from './constants';
import type { ToolContext } from './registry';

const MAX_PREVIEW_CHARS = 500;
const SENSITIVE_ASSIGNMENT_RE =
  /(api[_-]?key|apikey|authorization|cookie|credential|password|private[_-]?key|secret|token)\s*[:=]\s*[^\s,'"}]+/gi;
const BEARER_TOKEN_RE = /bearer\s+[a-z0-9._~+\/-]+/gi;

interface ToolInvocationAuditParams {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  durationMs: number;
  ctx: ToolContext;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactPreview(value: string): string {
  return value
    .slice(0, MAX_PREVIEW_CHARS)
    .replace(BEARER_TOKEN_RE, 'Bearer [redacted]')
    .replace(SENSITIVE_ASSIGNMENT_RE, (match) => {
      const prefix = match.match(/^[^:=]+/)?.[0]?.trim() ?? 'secret';
      return `${prefix}=[redacted]`;
    });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorPayload(error: unknown): Record<string, unknown> | null {
  if (!error) return null;
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : 'Error',
      message: typeof record.message === 'string' ? record.message : JSON.stringify(record),
    };
  }
  return { name: 'Error', message: String(error) };
}

function buildPayload(params: ToolInvocationAuditParams): Record<string, unknown> | null {
  const result = asObject(params.result);
  const toolError = params.error ? errorPayload(params.error) : null;

  if (params.toolName === 'run_sdk') {
    const script = typeof params.args.script === 'string' ? params.args.script : '';
    const resultError = errorPayload(result.error);
    return {
      tool_name: params.toolName,
      dry_run: params.args.dry_run === true,
      script_sha256: script ? sha256(script) : null,
      script_preview_redacted: script ? redactPreview(script) : null,
      sdk_call_count: typeof result.sdk_calls === 'number' ? result.sdk_calls : null,
      sdk_call_trace: Array.isArray(result.sdk_call_trace) ? result.sdk_call_trace : [],
      side_effect_preview: Array.isArray(result.side_effect_preview)
        ? result.side_effect_preview
        : [],
      side_effect_count: Array.isArray(result.side_effect_preview)
        ? result.side_effect_preview.length
        : 0,
      success: toolError ? false : result.success === true,
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  if (params.toolName === 'query_sql') {
    const sql = typeof params.args.sql === 'string' ? params.args.sql : '';
    const resultError = typeof result.error === 'string' ? { name: 'QuerySqlError', message: result.error } : null;
    return {
      tool_name: params.toolName,
      sql_sha256: sql ? sha256(sql) : null,
      sql_preview_redacted: sql ? redactPreview(sql) : null,
      sort_by: typeof params.args.sort_by === 'string' ? params.args.sort_by : null,
      sort_order: params.args.sort_order === 'desc' ? 'desc' : 'asc',
      limit: typeof params.args.limit === 'number' ? params.args.limit : null,
      offset: typeof params.args.offset === 'number' ? params.args.offset : null,
      row_count: Array.isArray(result.rows) ? result.rows.length : 0,
      total_count: typeof result.total_count === 'number' ? result.total_count : null,
      success: !(toolError || resultError),
      error: toolError ?? resultError,
      duration_ms: params.durationMs,
    };
  }

  return null;
}

export async function recordToolInvocationAudit(
  params: ToolInvocationAuditParams
): Promise<void> {
  const payload = buildPayload(params);
  if (!payload) return;

  try {
    const success = payload.success === true;
    await insertEvent({
      entityIds: [],
      organizationId: params.ctx.organizationId,
      originId: `tool_invocation:${params.toolName}:${Date.now()}:${randomUUID()}`,
      title: `${params.toolName} ${success ? 'completed' : 'failed'}`,
      payloadType: 'empty',
      payloadData: payload,
      semanticType: AUDIT_SEMANTIC_TYPE,
      originType: 'tool_invocation',
      metadata: {
        category: 'audit',
        event_type: 'tool_invocation.completed',
        tool_name: params.toolName,
        token_type: params.ctx.tokenType,
        agent_id: params.ctx.agentId ?? null,
      },
      createdBy: params.ctx.userId ?? null,
      clientId: params.ctx.clientId ?? null,
    });
  } catch (auditError) {
    logger.warn(
      { err: auditError, toolName: params.toolName },
      'Failed to record tool invocation audit event'
    );
  }
}
