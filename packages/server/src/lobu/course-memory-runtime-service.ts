import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { getDb, type DbClient } from '../db/client';
import { enqueueEmbeddingBackfillRun } from '../scheduled/trigger-embed-backfill';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import { AGENT_ID_PATTERN } from './stores/postgres-stores';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/;
const COURSE_ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/;
const MAX_CONTENT_LENGTH = 200_000;
const MAX_METADATA_BYTES = 64_000;
const RESERVED_METADATA_KEYS = new Set([
  'source',
  'memory_source',
  'ownerUserId',
  'owner_user_id',
  'agentId',
  'agent_id',
  'courseEntityId',
  'course_entity_id',
  'courseEntityIds',
  'course_entity_ids',
  'courseRevision',
  'course_revision',
  'contextPackId',
  'context_pack_id',
  'contentDigest',
  'content_digest',
  'requestFingerprint',
  'request_fingerprint',
  'traceId',
  'trace_id',
  'contract',
  'contract_name',
  'schemaVersion',
  'schema_version',
  'supersedesEventId',
  'supersedes_event_id',
]);

export type CourseMemoryOutcome = 'completed' | 'pending' | 'rejected' | 'indeterminate';
export type CourseMemoryIndexStatus = 'ready' | 'pending' | 'failed' | null;

export interface CourseContextProjectionPayload {
  title: string;
  summary: string;
  content: string;
  semanticType: string;
  metadata: Record<string, unknown>;
}

export interface CourseMemoryApplyCommand {
  contract: { name: 'course_context_projection'; schemaVersion: 2 };
  ownerUserId: string;
  agentId: string;
  courseEntityId: string;
  courseRevision: number;
  contextPackId: string;
  contentDigest: `sha256:${string}`;
  idempotencyKey: string;
  traceId: string;
  payload: CourseContextProjectionPayload;
}

export interface CourseMemoryReceipt {
  outcome: CourseMemoryOutcome;
  ownerUserId: string;
  agentId: string;
  courseEntityId: string;
  requestedCourseRevision: number;
  acceptedCourseRevision: number | null;
  appliedCourseRevision: number | null;
  contentDigest: `sha256:${string}` | null;
  memoryEventId: number | null;
  indexStatus: CourseMemoryIndexStatus;
  receiptRef: string;
  observedAt: string;
}

export type CourseMemoryRuntimeErrorCode =
  | 'memory.invalid_request'
  | 'memory.reserved_metadata_override'
  | 'memory.owner_agent_mismatch'
  | 'memory.idempotency_conflict'
  | 'memory.stale_revision'
  | 'memory.revision_conflict';

export class CourseMemoryRuntimeError extends Error {
  constructor(
    readonly code: CourseMemoryRuntimeErrorCode,
    message: string,
    readonly status: 400 | 403 | 409
  ) {
    super(message);
    this.name = 'CourseMemoryRuntimeError';
  }
}

interface ReceiptRow {
  receipt_ref: string;
  owner_user_id: string;
  agent_id: string;
  course_entity_id: string;
  requested_revision: number;
  accepted_revision: number | null;
  applied_revision: number | null;
  content_digest: `sha256:${string}`;
  request_fingerprint: `sha256:${string}`;
  memory_event_id: number | null;
  index_status: CourseMemoryIndexStatus;
  outcome: CourseMemoryOutcome;
  observed_at: string | Date;
  idempotency_key: string;
  rejection_code: string | null;
}

interface HeadRow {
  applied_revision: number;
  content_digest: `sha256:${string}`;
  memory_event_id: number;
  receipt_id: string;
}

interface ReceiptReadbackRow extends ReceiptRow {
  head_applied_revision: number | null;
  head_content_digest: `sha256:${string}` | null;
  head_memory_event_id: number | null;
  event_organization_id: string | null;
  event_title: string | null;
  event_payload_text: string | null;
  event_payload_data: Record<string, unknown> | null;
  event_semantic_type: string | null;
  event_metadata: Record<string, unknown> | null;
}

type InsertEventImpl = typeof insertEvent;

export interface CourseMemoryRuntimeServiceDependencies {
  sql?: DbClient;
  insertEventImpl?: InsertEventImpl;
  enqueueEmbeddingBackfill?: typeof enqueueEmbeddingBackfillRun;
  randomUuid?: () => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function requireBoundedString(value: unknown, field: string, maxLength = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new CourseMemoryRuntimeError(
      'memory.invalid_request',
      `${field} is required and must be at most ${maxLength} characters`,
      400
    );
  }
  return normalized;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, field: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new CourseMemoryRuntimeError(
      'memory.invalid_request',
      `${field} contains unsupported field ${unknown}`,
      400
    );
  }
}

export function parseCourseMemoryApplyCommand(
  body: unknown,
  pathCourseEntityId: string
): CourseMemoryApplyCommand {
  if (!isPlainRecord(body)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'Request body must be an object', 400);
  }
  rejectUnknownKeys(body, new Set([
    'contract', 'ownerUserId', 'agentId', 'courseRevision', 'contextPackId',
    'contentDigest', 'idempotencyKey', 'traceId', 'payload',
  ]), 'request');

  if (!isPlainRecord(body.contract)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'contract is required', 400);
  }
  rejectUnknownKeys(body.contract, new Set(['name', 'schemaVersion']), 'contract');
  if (body.contract.name !== 'course_context_projection' || body.contract.schemaVersion !== 2) {
    throw new CourseMemoryRuntimeError(
      'memory.invalid_request',
      'contract must be course_context_projection schemaVersion 2',
      400
    );
  }

  const ownerUserId = requireBoundedString(body.ownerUserId, 'ownerUserId');
  const agentId = requireBoundedString(body.agentId, 'agentId');
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'agentId is invalid', 400);
  }
  const courseEntityId = requireBoundedString(pathCourseEntityId, 'courseEntityId');
  if (!COURSE_ENTITY_ID_PATTERN.test(courseEntityId)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'courseEntityId is invalid', 400);
  }
  if (!Number.isSafeInteger(body.courseRevision) || Number(body.courseRevision) <= 0) {
    throw new CourseMemoryRuntimeError(
      'memory.invalid_request',
      'courseRevision must be a positive safe integer',
      400
    );
  }
  const contextPackId = requireBoundedString(body.contextPackId, 'contextPackId');
  const contentDigest = requireBoundedString(body.contentDigest, 'contentDigest') as `sha256:${string}`;
  if (!SHA256_PATTERN.test(contentDigest)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'contentDigest is invalid', 400);
  }
  const idempotencyKey = requireBoundedString(body.idempotencyKey, 'idempotencyKey');
  const traceId = requireBoundedString(body.traceId, 'traceId');
  if (!SAFE_ID_PATTERN.test(idempotencyKey) || !SAFE_ID_PATTERN.test(traceId)) {
    throw new CourseMemoryRuntimeError(
      'memory.invalid_request',
      'idempotencyKey and traceId must be safe identifiers',
      400
    );
  }
  if (!isPlainRecord(body.payload)) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'payload is required', 400);
  }
  rejectUnknownKeys(
    body.payload,
    new Set(['title', 'summary', 'content', 'semanticType', 'metadata']),
    'payload'
  );
  const title = requireBoundedString(body.payload.title, 'payload.title', 500);
  const summary = requireBoundedString(body.payload.summary, 'payload.summary', MAX_CONTENT_LENGTH);
  const content = requireBoundedString(body.payload.content, 'payload.content', MAX_CONTENT_LENGTH);
  const semanticType = requireBoundedString(body.payload.semanticType, 'payload.semanticType', 100);
  const metadata = body.payload.metadata ?? {};
  if (!isPlainRecord(metadata) || JSON.stringify(metadata).length > MAX_METADATA_BYTES) {
    throw new CourseMemoryRuntimeError('memory.invalid_request', 'payload.metadata is invalid', 400);
  }
  const reserved = Object.keys(metadata).find((key) => RESERVED_METADATA_KEYS.has(key));
  if (reserved) {
    throw new CourseMemoryRuntimeError(
      'memory.reserved_metadata_override',
      `payload.metadata cannot override ${reserved}`,
      400
    );
  }

  return {
    contract: { name: 'course_context_projection', schemaVersion: 2 },
    ownerUserId,
    agentId,
    courseEntityId,
    courseRevision: Number(body.courseRevision),
    contextPackId,
    contentDigest,
    idempotencyKey,
    traceId,
    payload: { title, summary, content, semanticType, metadata },
  };
}

function toReceipt(row: ReceiptRow): CourseMemoryReceipt {
  const observedAt = row.observed_at instanceof Date
    ? row.observed_at.toISOString()
    : new Date(row.observed_at).toISOString();
  return {
    outcome: row.outcome,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    courseEntityId: row.course_entity_id,
    requestedCourseRevision: Number(row.requested_revision),
    acceptedCourseRevision: row.accepted_revision == null ? null : Number(row.accepted_revision),
    appliedCourseRevision: row.applied_revision == null ? null : Number(row.applied_revision),
    contentDigest: row.content_digest ?? null,
    memoryEventId: row.memory_event_id == null ? null : Number(row.memory_event_id),
    indexStatus: row.index_status,
    receiptRef: row.receipt_ref,
    observedAt,
  };
}

/**
 * Canonical v2 projection fingerprint. This covers every normalized field that
 * can change the durable projection. Transport-only idempotencyKey/traceId and
 * server-derived event metadata are deliberately excluded.
 */
function projectionFingerprint(command: CourseMemoryApplyCommand): `sha256:${string}` {
  const canonical = canonicalize({
    contract: command.contract,
    ownerUserId: command.ownerUserId,
    agentId: command.agentId,
    courseEntityId: command.courseEntityId,
    courseRevision: command.courseRevision,
    contextPackId: command.contextPackId,
    contentDigest: command.contentDigest,
    payload: command.payload,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function callerProjectionMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key))
  );
}

function exactReplay(row: ReceiptRow, command: CourseMemoryApplyCommand): boolean {
  return row.owner_user_id === command.ownerUserId
    && row.agent_id === command.agentId
    && row.course_entity_id === command.courseEntityId
    && Number(row.requested_revision) === command.courseRevision
    && row.content_digest === command.contentDigest
    && row.request_fingerprint === projectionFingerprint(command);
}

function requiredReceiptRow(row: ReceiptRow | undefined): ReceiptRow {
  if (!row) throw new Error('Course memory receipt INSERT RETURNING produced no row');
  return row;
}

function errorForRejectedReceipt(row: ReceiptRow): CourseMemoryRuntimeError {
  const code = row.rejection_code === 'memory.stale_revision'
    ? 'memory.stale_revision'
    : 'memory.revision_conflict';
  return new CourseMemoryRuntimeError(code, 'Course memory projection revision was rejected', 409);
}

export function createCourseMemoryRuntimeService(
  dependencies: CourseMemoryRuntimeServiceDependencies = {}
) {
  const sql = dependencies.sql ?? getDb();
  const insert = dependencies.insertEventImpl ?? insertEvent;
  const enqueue = dependencies.enqueueEmbeddingBackfill ?? enqueueEmbeddingBackfillRun;
  const newUuid = dependencies.randomUuid ?? randomUUID;

  async function inspect(input: {
    organizationId: string;
    ownerUserId: string;
    agentId: string;
    courseEntityId: string;
    idempotencyKey: string;
  }): Promise<CourseMemoryReceipt | null> {
    const rows = await sql<ReceiptReadbackRow>`
      SELECT r.*,
             h.applied_revision AS head_applied_revision,
             h.content_digest AS head_content_digest,
             h.memory_event_id AS head_memory_event_id,
             e.organization_id AS event_organization_id,
             e.title AS event_title,
             e.payload_text AS event_payload_text,
             e.payload_data AS event_payload_data,
             e.semantic_type AS event_semantic_type,
             e.metadata AS event_metadata
      FROM course_memory_apply_receipts r
      LEFT JOIN course_memory_heads h
        ON h.organization_id = r.organization_id
       AND h.owner_user_id = r.owner_user_id
       AND h.agent_id = r.agent_id
       AND h.course_entity_id = r.course_entity_id
      LEFT JOIN events e ON e.id = r.memory_event_id
      WHERE r.organization_id = ${input.organizationId}
        AND r.owner_user_id = ${input.ownerUserId}
        AND r.agent_id = ${input.agentId}
        AND r.course_entity_id = ${input.courseEntityId}
        AND r.idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.outcome === 'completed') {
      const metadata = row.event_metadata;
      const requestedRevision = Number(row.requested_revision);
      const headRevision = Number(row.head_applied_revision);
      const currentHeadExact = headRevision === requestedRevision
        ? row.head_content_digest === row.content_digest
          && Number(row.head_memory_event_id) === Number(row.memory_event_id)
        : headRevision > requestedRevision;
      const persistedSummary = row.event_payload_data?.summary;
      const persistedFingerprint = metadata
        && typeof row.event_title === 'string'
        && typeof row.event_payload_text === 'string'
        && typeof row.event_semantic_type === 'string'
        && typeof persistedSummary === 'string'
        ? projectionFingerprint({
          contract: { name: 'course_context_projection', schemaVersion: 2 },
          ownerUserId: input.ownerUserId,
          agentId: input.agentId,
          courseEntityId: input.courseEntityId,
          courseRevision: requestedRevision,
          contextPackId: String(metadata.context_pack_id ?? ''),
          contentDigest: String(metadata.content_digest ?? '') as `sha256:${string}`,
          idempotencyKey: row.idempotency_key,
          traceId: String(metadata.trace_id ?? ''),
          payload: {
            title: row.event_title,
            summary: persistedSummary,
            content: row.event_payload_text,
            semanticType: row.event_semantic_type,
            metadata: callerProjectionMetadata(metadata),
          },
        })
        : null;
      const exact = Number(row.accepted_revision) === Number(row.requested_revision)
        && Number(row.applied_revision) === Number(row.requested_revision)
        && currentHeadExact
        && row.event_organization_id === input.organizationId
        && metadata?.owner_user_id === input.ownerUserId
        && metadata?.agent_id === input.agentId
        && metadata?.course_entity_id === input.courseEntityId
        && Array.isArray(metadata?.course_entity_ids)
        && metadata.course_entity_ids.length === 1
        && metadata.course_entity_ids[0] === input.courseEntityId
        && Number(metadata?.course_revision) === Number(row.requested_revision)
        && metadata?.content_digest === row.content_digest
        && metadata?.request_fingerprint === row.request_fingerprint
        && persistedFingerprint === row.request_fingerprint;
      if (!exact) {
        throw new Error('Course memory completed receipt failed exact durable readback');
      }
    }
    return toReceipt(row);
  }

  async function inspectByIdempotencyKey(input: {
    organizationId: string;
    courseEntityId: string;
    idempotencyKey: string;
  }): Promise<CourseMemoryReceipt | null> {
    const identities = await sql<{ owner_user_id: string; agent_id: string }>`
      SELECT r.owner_user_id, r.agent_id
      FROM course_memory_apply_receipts r
      JOIN agents a
        ON a.organization_id = r.organization_id
       AND a.id = r.agent_id
       AND a.owner_user_id = r.owner_user_id
      JOIN course_memory_heads h
        ON h.organization_id = r.organization_id
       AND h.owner_user_id = r.owner_user_id
       AND h.agent_id = r.agent_id
       AND h.course_entity_id = r.course_entity_id
      WHERE r.organization_id = ${input.organizationId}
        AND r.course_entity_id = ${input.courseEntityId}
        AND r.idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    const identity = identities[0];
    if (!identity) return null;
    return inspect({
      ...input,
      ownerUserId: identity.owner_user_id,
      agentId: identity.agent_id,
    });
  }

  return {
    async apply(input: { organizationId: string; command: CourseMemoryApplyCommand }) {
      const { organizationId } = input;
      const { courseEntityId, ...body } = input.command;
      const command = parseCourseMemoryApplyCommand(body, courseEntityId);
      const requestFingerprint = projectionFingerprint(command);
      let insertedNewEvent = false;
      const result = await sql.begin(async (tx) => {
        const lockScope = [
          organizationId,
          command.ownerUserId,
          command.agentId,
          command.courseEntityId,
        ].join('\u001f');
        const idempotencyLock = [organizationId, command.idempotencyKey].join('\u001f');
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyLock}, 0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockScope}, 0))`;

        const agents = await tx`
          SELECT id, owner_user_id
          FROM agents
          WHERE organization_id = ${organizationId}
            AND id = ${command.agentId}
          FOR UPDATE
        `;
        if (agents.length !== 1 || agents[0]?.owner_user_id !== command.ownerUserId) {
          throw new CourseMemoryRuntimeError(
            'memory.owner_agent_mismatch',
            'Agent is not owned by ownerUserId in this organization',
            403
          );
        }

        const sameKey = await tx<ReceiptRow>`
          SELECT *
          FROM course_memory_apply_receipts
          WHERE organization_id = ${organizationId}
            AND idempotency_key = ${command.idempotencyKey}
          LIMIT 1
          FOR UPDATE
        `;
        if (sameKey[0]) {
          if (!exactReplay(sameKey[0], command)) {
            throw new CourseMemoryRuntimeError(
              'memory.idempotency_conflict',
              'Idempotency key was already used for a different projection',
              409
            );
          }
          if (sameKey[0].outcome === 'rejected') throw errorForRejectedReceipt(sameKey[0]);
          return toReceipt(sameKey[0]);
        }

        const heads = await tx<HeadRow>`
          SELECT applied_revision, content_digest, memory_event_id, receipt_id
          FROM course_memory_heads
          WHERE organization_id = ${organizationId}
            AND owner_user_id = ${command.ownerUserId}
            AND agent_id = ${command.agentId}
            AND course_entity_id = ${command.courseEntityId}
          FOR UPDATE
        `;
        let head = heads[0];
        if (!head) {
          const historicalHeads = await tx<HeadRow>`
            SELECT r.applied_revision,
                   r.content_digest,
                   r.memory_event_id,
                   r.id AS receipt_id
            FROM course_memory_apply_receipts r
            JOIN events e ON e.id = r.memory_event_id
            WHERE r.organization_id = ${organizationId}
              AND r.owner_user_id = ${command.ownerUserId}
              AND r.agent_id = ${command.agentId}
              AND r.course_entity_id = ${command.courseEntityId}
              AND r.outcome = 'completed'
              AND r.applied_revision IS NOT NULL
              AND e.organization_id = ${organizationId}
              AND e.metadata->>'owner_user_id' = ${command.ownerUserId}
              AND e.metadata->>'agent_id' = ${command.agentId}
              AND e.metadata->>'course_entity_id' = ${command.courseEntityId}
              AND jsonb_typeof(e.metadata->'course_entity_ids') = 'array'
              AND jsonb_array_length(e.metadata->'course_entity_ids') = 1
              AND e.metadata->'course_entity_ids'->>0 = ${command.courseEntityId}
              AND e.metadata->>'content_digest' = r.content_digest
              AND e.metadata->>'request_fingerprint' = r.request_fingerprint
            ORDER BY r.applied_revision DESC, r.id DESC
            LIMIT 1
            FOR UPDATE OF r
          `;
          head = historicalHeads[0];
        }
        const revisionRows = await tx<ReceiptRow>`
          SELECT *
          FROM course_memory_apply_receipts
          WHERE organization_id = ${organizationId}
            AND owner_user_id = ${command.ownerUserId}
            AND agent_id = ${command.agentId}
            AND course_entity_id = ${command.courseEntityId}
            AND requested_revision = ${command.courseRevision}
          LIMIT 1
          FOR UPDATE
        `;
        if (revisionRows[0]) {
          throw new CourseMemoryRuntimeError(
            'memory.revision_conflict',
            'Course revision was already attempted with a different idempotency key',
            409
          );
        }

        if (head && command.courseRevision < Number(head.applied_revision)) {
          const receiptId = newUuid();
          const receiptRef = `course-memory-receipt:${receiptId}`;
          const rows = await tx<ReceiptRow>`
            INSERT INTO course_memory_apply_receipts (
              id, receipt_ref, organization_id, owner_user_id, agent_id,
              course_entity_id, idempotency_key, requested_revision,
              accepted_revision, applied_revision, content_digest,
              request_fingerprint, memory_event_id, index_status, outcome, trace_id, rejection_code
            ) VALUES (
              ${receiptId}, ${receiptRef}, ${organizationId}, ${command.ownerUserId},
              ${command.agentId}, ${command.courseEntityId}, ${command.idempotencyKey},
              ${command.courseRevision}, ${head.applied_revision}, ${head.applied_revision},
              ${command.contentDigest}, ${requestFingerprint}, NULL, NULL, 'rejected', ${command.traceId},
              'memory.stale_revision'
            )
            RETURNING *
          `;
          return { rejected: errorForRejectedReceipt(requiredReceiptRow(rows[0])) };
        }
        if (head && command.courseRevision === Number(head.applied_revision)) {
          throw new CourseMemoryRuntimeError(
            'memory.revision_conflict',
            head.content_digest === command.contentDigest
              ? 'Course revision was already applied with a different idempotency key'
              : 'Course revision was already applied with a different digest',
            409
          );
        }

        const receiptId = newUuid();
        const receiptRef = `course-memory-receipt:${receiptId}`;
        const supersedesEventId = head ? Number(head.memory_event_id) : null;
        const metadata = {
          ...command.payload.metadata,
          source: 'toolbox_onboarding',
          memory_source: 'course_context_projection_v2',
          owner_user_id: command.ownerUserId,
          agent_id: command.agentId,
          course_entity_id: command.courseEntityId,
          course_entity_ids: [command.courseEntityId],
          course_revision: command.courseRevision,
          context_pack_id: command.contextPackId,
          content_digest: command.contentDigest,
          request_fingerprint: requestFingerprint,
          trace_id: command.traceId,
          contract_name: command.contract.name,
          schema_version: command.contract.schemaVersion,
          supersedes_event_id: supersedesEventId,
        };
        const event = await insert({
          entityIds: [],
          organizationId,
          originId: `course-memory:${receiptId}`,
          title: command.payload.title,
          payloadType: 'markdown',
          content: command.payload.content,
          payloadData: { summary: command.payload.summary },
          semanticType: command.payload.semanticType,
          originType: 'course_context_projection',
          metadata,
          supersedesEventId,
          createdBy: command.ownerUserId,
        }, { sql: tx as ReturnType<typeof getDb> });
        insertedNewEvent = true;

        const rows = await tx<ReceiptRow>`
          INSERT INTO course_memory_apply_receipts (
            id, receipt_ref, organization_id, owner_user_id, agent_id,
            course_entity_id, idempotency_key, requested_revision,
            accepted_revision, applied_revision, content_digest,
            request_fingerprint, memory_event_id, index_status, outcome, trace_id
          ) VALUES (
            ${receiptId}, ${receiptRef}, ${organizationId}, ${command.ownerUserId},
            ${command.agentId}, ${command.courseEntityId}, ${command.idempotencyKey},
            ${command.courseRevision}, ${command.courseRevision}, ${command.courseRevision},
            ${command.contentDigest}, ${requestFingerprint}, ${event.id}, 'pending', 'completed', ${command.traceId}
          )
          RETURNING *
        `;
        await tx`
          INSERT INTO course_memory_heads (
            organization_id, owner_user_id, agent_id, course_entity_id,
            applied_revision, content_digest, memory_event_id, receipt_id
          ) VALUES (
            ${organizationId}, ${command.ownerUserId}, ${command.agentId},
            ${command.courseEntityId}, ${command.courseRevision}, ${command.contentDigest},
            ${event.id}, ${receiptId}
          )
          ON CONFLICT (organization_id, owner_user_id, agent_id, course_entity_id)
          DO UPDATE SET
            applied_revision = EXCLUDED.applied_revision,
            content_digest = EXCLUDED.content_digest,
            memory_event_id = EXCLUDED.memory_event_id,
            receipt_id = EXCLUDED.receipt_id,
            updated_at = now()
        `;
        return toReceipt(requiredReceiptRow(rows[0]));
      });

      if ('rejected' in result) throw result.rejected;
      const readback = await inspect({
        organizationId,
        ownerUserId: command.ownerUserId,
        agentId: command.agentId,
        courseEntityId: command.courseEntityId,
        idempotencyKey: command.idempotencyKey,
      });
      if (!readback) throw new Error('Course memory receipt missing after committed apply');
      if (insertedNewEvent) {
        try {
          await enqueue(organizationId);
        } catch (error) {
          logger.warn(
            { organizationId, error: { name: error instanceof Error ? error.name : 'UnknownError' } },
            '[CourseMemoryRuntime] Post-commit embedding enqueue failed'
          );
        }
      }
      return readback;
    },

    inspect,
    inspectByIdempotencyKey,
  };
}
