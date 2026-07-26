import { createHash } from "node:crypto";
import { type DbClient, getDb, pgTextArray } from "../db/client.js";

const CURSOR_VERSION = 1;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 200;
const MAX_AGENT_ID_LENGTH = 60;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CONTENT_LENGTH = 16 * 1024;
const MAX_PROCESSED_MESSAGE_IDS = 64;
const MAX_CURSOR_LENGTH = 1024;
const MAX_SOURCE_BATCH_ROWS = 1024;
const MIN_SOURCE_BATCH_ROWS = 64;
const SOURCE_ROWS_PER_OUTPUT_EVENT = 8;
const SOURCE_BOUNDARY_EVENT_INDEX = MAX_PROCESSED_MESSAGE_IDS + 1;
const MAX_LOOKUP_MESSAGE_IDS = MAX_SOURCE_BATCH_ROWS;
const SHIFU_USER_AGENT_ID_PATTERN = /^shifu-u-[a-z0-9-]{1,51}$/;

export interface RuntimeReadModelRepairEvent {
	type: "line_inbound" | "assistant_complete";
	toolboxUserId: string;
	lineUserId: null;
	agentId: string;
	lobuConversationId: string;
	content: string;
	messageId: string;
	eventId: null;
	roundId: null;
	decisionId: null;
	submittedValue: null;
	submittedAt: null;
	occurredAt: string;
}

export interface RuntimeReadModelEventsResult {
	events: RuntimeReadModelRepairEvent[];
	nextCursor: string | null;
	quarantined: number;
}

export interface RuntimeReadModelEventsInput {
	organizationId: string;
	agentId: string;
	from: string;
	to: string;
	limit: number;
	cursor?: string;
	sql?: DbClient;
}

export class RuntimeReadModelValidationError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

interface DurableRunRow {
	run_id: number | string;
	created_at: Date | string;
	queue_name: string | null;
	action_input: unknown;
}

interface InboundProofRow extends DurableRunRow {
	message_id: string;
	match_count: number | string | null;
}

interface InboundSource {
	toolboxUserId: string;
	agentId: string;
	conversationId: string;
	messageId: string;
	content: string;
	occurredAt: string;
}

interface ProjectedEvent {
	event: RuntimeReadModelRepairEvent;
	runId: number;
	eventIndex: number;
	createdAt: string;
}

interface RuntimeReadModelCursor {
	v: number;
	r: number;
	e: number;
	t: string;
	s: string;
}

/**
 * Projects only durable queue rows. It keeps no local state, so every replica
 * applies the same organization-scoped ordering and opaque cursor rules.
 */
export async function readRuntimeReadModelEvents(
	input: RuntimeReadModelEventsInput,
): Promise<RuntimeReadModelEventsResult> {
	const validated = validateInput(input);
	const scope = cursorScope(
		input.organizationId,
		input.agentId,
		input.from,
		input.to,
	);
	const cursor = input.cursor ? parseCursor(input.cursor, scope) : null;
	const sql = input.sql ?? getDb();
	const sourceLimit = sourceBatchLimit(input.limit);
	const rows = await readSourceBatch(
		sql,
		input,
		validated,
		cursor,
		sourceLimit,
	);

	const inboundByRunId = new Map<number, InboundSource>();
	const messageIdsNeedingProof: string[] = [];
	const proofMessageIdSet = new Set<string>();
	const unprovedInboundRunIds = new Set<number>();
	const candidates: Array<{
		row: DurableRunRow;
		createdAt: string;
		runId: number;
	}> = [];
	let quarantined = 0;

	for (const row of rows) {
		const runId = safeRunId(row.run_id);
		const createdAt = isoTimestamp(row.created_at);
		if (!runId || !createdAt) {
			quarantined += 1;
			continue;
		}
		candidates.push({ row, createdAt, runId });
		if (isInboundQueue(row.queue_name)) {
			if (!isObject(row.action_input) || row.action_input.platform !== "line") {
				continue;
			}
			const source = parseInbound(row.action_input, input.agentId, createdAt);
			if (!source) {
				quarantined += 1;
				continue;
			}
			inboundByRunId.set(runId, source);
			if (
				!addProofMessageId(
					messageIdsNeedingProof,
					proofMessageIdSet,
					source.messageId,
				)
			) {
				unprovedInboundRunIds.add(runId);
			}
			continue;
		}
		if (row.queue_name === "thread_response") {
			for (const messageId of processedMessageIdsForLookup(row.action_input)) {
				addProofMessageId(messageIdsNeedingProof, proofMessageIdSet, messageId);
			}
		}
	}
	const inboundProofs = await readInboundProofs(
		sql,
		input,
		validated,
		messageIdsNeedingProof,
	);
	const inboundByMessageId = new Map<string, InboundSource>();
	for (const [runId, source] of inboundByRunId) {
		if (
			unprovedInboundRunIds.has(runId) ||
			inboundProofs.get(source.messageId)?.matchCount !== 1
		) {
			quarantined += 1;
			continue;
		}
		inboundByMessageId.set(source.messageId, source);
	}
	const missingInboundMessageIds = messageIdsNeedingProof.filter(
		(messageId) =>
			inboundProofs.get(messageId)?.matchCount === 1 &&
			!inboundByMessageId.has(messageId),
	);
	for (const messageId of missingInboundMessageIds) {
		const proof = inboundProofs.get(messageId);
		if (!proof) continue;
		const createdAt = isoTimestamp(proof.created_at);
		const source = createdAt
			? parseInbound(proof.action_input, input.agentId, createdAt)
			: null;
		if (!source || proof.matchCount !== 1) continue;
		inboundByMessageId.set(source.messageId, source);
	}

	const projected: ProjectedEvent[] = [];
	for (const candidate of candidates) {
		if (isInboundQueue(candidate.row.queue_name)) {
			const source = parseInbound(
				candidate.row.action_input,
				input.agentId,
				candidate.createdAt,
			);
			if (!source || !inboundByMessageId.has(source.messageId)) continue;
			projected.push({
				event: toInboundEvent(source),
				runId: candidate.runId,
				eventIndex: 0,
				createdAt: candidate.createdAt,
			});
			continue;
		}
		if (candidate.row.queue_name !== "thread_response") continue;
		const completions = parseCompletions(
			candidate.row.action_input,
			input.agentId,
			inboundByMessageId,
			candidate.createdAt,
		);
		if (!completions) {
			quarantined += 1;
			continue;
		}
		for (const [index, event] of completions.entries()) {
			projected.push({
				event,
				runId: candidate.runId,
				eventIndex: index + 1,
				createdAt: candidate.createdAt,
			});
		}
	}

	const resumed = cursor
		? projected.filter((event) => compareEventToCursor(event, cursor) > 0)
		: projected;
	const events = resumed.slice(0, input.limit);
	const last = events.at(-1);
	const lastSource = rows.at(-1);
	const sourceExhausted = rows.length < sourceLimit;
	return {
		events: events.map(({ event }) => event),
		nextCursor:
			last && resumed.length > events.length
				? encodeCursor({
						v: CURSOR_VERSION,
						r: last.runId,
						e: last.eventIndex,
						t: last.createdAt,
						s: scope,
					})
				: !sourceExhausted && lastSource
					? sourceBoundaryCursor(lastSource, scope)
					: null,
		quarantined,
	};
}

function validateInput(input: RuntimeReadModelEventsInput): {
	from: Date;
	to: Date;
} {
	if (
		typeof input.organizationId !== "string" ||
		!boundedString(input.organizationId, MAX_IDENTIFIER_LENGTH)
	) {
		throw new RuntimeReadModelValidationError("invalid_organization");
	}
	if (
		typeof input.agentId !== "string" ||
		input.agentId.length > MAX_AGENT_ID_LENGTH ||
		!SHIFU_USER_AGENT_ID_PATTERN.test(input.agentId)
	) {
		throw new RuntimeReadModelValidationError("invalid_agent_id");
	}
	if (
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > MAX_LIMIT
	) {
		throw new RuntimeReadModelValidationError("invalid_limit");
	}
	const from = parseTimestamp(input.from);
	const to = parseTimestamp(input.to);
	if (
		!from ||
		!to ||
		from >= to ||
		to.getTime() - from.getTime() > MAX_WINDOW_MS
	) {
		throw new RuntimeReadModelValidationError("invalid_time_window");
	}
	return { from, to };
}

function sourceBatchLimit(limit: number): number {
	return Math.min(
		MAX_SOURCE_BATCH_ROWS,
		Math.max(MIN_SOURCE_BATCH_ROWS, limit * SOURCE_ROWS_PER_OUTPUT_EVENT),
	);
}

async function readSourceBatch(
	sql: DbClient,
	input: RuntimeReadModelEventsInput,
	window: { from: Date; to: Date },
	cursor: RuntimeReadModelCursor | null,
	limit: number,
): Promise<DurableRunRow[]> {
	const base = {
		organizationId: input.organizationId,
		agentId: input.agentId,
		from: window.from.toISOString(),
		to: window.to.toISOString(),
	};
	if (!cursor) {
		return sql<DurableRunRow>`
			SELECT id AS run_id, created_at, queue_name, action_input
			FROM public.runs
			WHERE organization_id = ${base.organizationId}
				AND created_at >= ${base.from}
				AND created_at < ${base.to}
				AND action_input ->> 'agentId' = ${base.agentId}
				AND EXISTS (
					SELECT 1 FROM public.agents
					WHERE agents.id = ${base.agentId}
						AND agents.organization_id = ${base.organizationId}
				)
				AND (
					queue_name = 'thread_response'
					OR queue_name LIKE 'thread_message\\_%' ESCAPE '\\'
				)
			ORDER BY created_at ASC, id ASC
			LIMIT ${limit}
		`;
	}
	if (cursor.e === SOURCE_BOUNDARY_EVENT_INDEX) {
		return sql<DurableRunRow>`
			SELECT id AS run_id, created_at, queue_name, action_input
			FROM public.runs
			WHERE organization_id = ${base.organizationId}
				AND created_at >= ${base.from}
				AND created_at < ${base.to}
				AND action_input ->> 'agentId' = ${base.agentId}
				AND EXISTS (
					SELECT 1 FROM public.agents
					WHERE agents.id = ${base.agentId}
						AND agents.organization_id = ${base.organizationId}
				)
				AND (
					queue_name = 'thread_response'
					OR queue_name LIKE 'thread_message\\_%' ESCAPE '\\'
				)
				AND (created_at > ${cursor.t} OR (created_at = ${cursor.t} AND id > ${cursor.r}))
			ORDER BY created_at ASC, id ASC
			LIMIT ${limit}
		`;
	}
	return sql<DurableRunRow>`
		SELECT id AS run_id, created_at, queue_name, action_input
		FROM public.runs
		WHERE organization_id = ${base.organizationId}
			AND created_at >= ${base.from}
			AND created_at < ${base.to}
			AND action_input ->> 'agentId' = ${base.agentId}
			AND EXISTS (
				SELECT 1 FROM public.agents
				WHERE agents.id = ${base.agentId}
					AND agents.organization_id = ${base.organizationId}
			)
			AND (
				queue_name = 'thread_response'
				OR queue_name LIKE 'thread_message\\_%' ESCAPE '\\'
			)
			AND (created_at > ${cursor.t} OR (created_at = ${cursor.t} AND id >= ${cursor.r}))
		ORDER BY created_at ASC, id ASC
		LIMIT ${limit}
	`;
}

interface InboundProof {
	matchCount: number;
	created_at: Date | string;
	action_input: unknown;
}

async function readInboundProofs(
	sql: DbClient,
	input: RuntimeReadModelEventsInput,
	window: { from: Date; to: Date },
	messageIds: string[],
): Promise<Map<string, InboundProof>> {
	if (messageIds.length === 0) return new Map();
	const rows = await sql<InboundProofRow>`
		WITH requested(message_id) AS (
			SELECT unnest(${pgTextArray(messageIds)}::text[])
		)
		SELECT requested.message_id,
			proof.match_count,
			proof.run_id,
			proof.created_at,
			proof.queue_name,
			proof.action_input
		FROM requested
		LEFT JOIN LATERAL (
			SELECT COUNT(*) OVER () AS match_count,
				matches.id AS run_id,
				matches.created_at,
				matches.queue_name,
				matches.action_input
			FROM (
				SELECT id, created_at, queue_name, action_input
				FROM public.runs
				WHERE organization_id = ${input.organizationId}
					AND created_at >= ${window.from.toISOString()}
					AND created_at < ${window.to.toISOString()}
					AND action_input ->> 'agentId' = ${input.agentId}
					AND action_input ->> 'messageId' = requested.message_id
					AND queue_name LIKE 'thread_message\\_%' ESCAPE '\\'
					AND action_input ->> 'platform' = 'line'
				ORDER BY created_at ASC, id ASC
				LIMIT 2
			) AS matches
			ORDER BY matches.created_at ASC, matches.id ASC
			LIMIT 1
		) AS proof ON true
		LIMIT ${messageIds.length}
	`;
	return new Map(
		rows.map((row) => [
			row.message_id,
			{
				matchCount: Number(row.match_count ?? 0),
				created_at: row.created_at,
				action_input: row.action_input,
			},
		]),
	);
}

function addProofMessageId(
	messageIds: string[],
	knownIds: Set<string>,
	messageId: string,
): boolean {
	if (knownIds.has(messageId)) return true;
	if (messageIds.length >= MAX_LOOKUP_MESSAGE_IDS) return false;
	knownIds.add(messageId);
	messageIds.push(messageId);
	return true;
}

function processedMessageIdsForLookup(value: unknown): string[] {
	if (!isObject(value) || !Array.isArray(value.processedMessageIds)) return [];
	const ids = value.processedMessageIds;
	if (ids.length === 0 || ids.length > MAX_PROCESSED_MESSAGE_IDS) return [];
	return ids.every((id) => boundedString(id, MAX_IDENTIFIER_LENGTH))
		? [...new Set(ids)]
		: [];
}

function sourceBoundaryCursor(
	row: DurableRunRow,
	scope: string,
): string | null {
	const runId = safeRunId(row.run_id);
	const createdAt = isoTimestamp(row.created_at);
	if (!runId || !createdAt) return null;
	return encodeCursor({
		v: CURSOR_VERSION,
		r: runId,
		e: SOURCE_BOUNDARY_EVENT_INDEX,
		t: createdAt,
		s: scope,
	});
}

function parseTimestamp(value: string): Date | null {
	if (typeof value !== "string" || value.length > 64) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString() === value
		? new Date(timestamp)
		: null;
}

function isInboundQueue(queueName: string | null): boolean {
	return (
		typeof queueName === "string" &&
		/^thread_message_[a-z0-9-]+$/.test(queueName)
	);
}

function parseInbound(
	value: unknown,
	expectedAgentId: string,
	occurredAt: string,
): InboundSource | null {
	if (!isObject(value) || value.platform !== "line") return null;
	const messageId = stringField(value, "messageId");
	const content = stringField(value, "messageText", MAX_CONTENT_LENGTH);
	const toolboxUserId = stringField(value, "userId");
	const agentId = stringField(value, "agentId");
	const conversationId = stringField(value, "conversationId");
	if (!messageId || !content || !toolboxUserId || !agentId || !conversationId)
		return null;
	if (agentId !== expectedAgentId) return null;
	return {
		toolboxUserId,
		agentId,
		conversationId,
		messageId,
		content,
		occurredAt,
	};
}

function parseCompletions(
	value: unknown,
	expectedAgentId: string,
	inboundByMessageId: ReadonlyMap<string, InboundSource>,
	occurredAt: string,
): RuntimeReadModelRepairEvent[] | null {
	if (!isObject(value)) return null;
	const finalText = stringField(value, "finalText", MAX_CONTENT_LENGTH);
	const agentId = stringField(value, "agentId");
	const toolboxUserId = stringField(value, "userId");
	const conversationId = stringField(value, "conversationId");
	const processedMessageIds = value.processedMessageIds;
	if (
		!finalText ||
		!agentId ||
		!toolboxUserId ||
		!conversationId ||
		agentId !== expectedAgentId ||
		!Array.isArray(processedMessageIds) ||
		processedMessageIds.length === 0 ||
		processedMessageIds.length > MAX_PROCESSED_MESSAGE_IDS
	) {
		return null;
	}
	const messageIds = processedMessageIds as unknown[];
	if (
		messageIds.some(
			(messageId) => !boundedString(messageId, MAX_IDENTIFIER_LENGTH),
		) ||
		new Set(messageIds).size !== messageIds.length
	) {
		return null;
	}
	const inbounds = messageIds.map((messageId) =>
		inboundByMessageId.get(messageId as string),
	);
	if (
		inbounds.some(
			(inbound) =>
				!inbound ||
				inbound.agentId !== agentId ||
				inbound.toolboxUserId !== toolboxUserId ||
				inbound.conversationId !== conversationId,
		)
	) {
		return null;
	}
	return messageIds.map((messageId) => ({
		type: "assistant_complete" as const,
		toolboxUserId,
		lineUserId: null,
		agentId,
		lobuConversationId: conversationId,
		content: finalText,
		messageId: messageId as string,
		eventId: null,
		roundId: null,
		decisionId: null,
		submittedValue: null,
		submittedAt: null,
		occurredAt,
	}));
}

function toInboundEvent(source: InboundSource): RuntimeReadModelRepairEvent {
	return {
		type: "line_inbound",
		toolboxUserId: source.toolboxUserId,
		lineUserId: null,
		agentId: source.agentId,
		lobuConversationId: source.conversationId,
		content: source.content,
		messageId: source.messageId,
		eventId: null,
		roundId: null,
		decisionId: null,
		submittedValue: null,
		submittedAt: null,
		occurredAt: source.occurredAt,
	};
}

function safeRunId(value: number | string): number | null {
	const runId = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

function isoTimestamp(value: Date | string): string | null {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stringField(
	value: Record<string, unknown>,
	field: string,
	maximum = MAX_IDENTIFIER_LENGTH,
): string | null {
	const candidate = value[field];
	return boundedString(candidate, maximum) ? candidate : null;
}

function boundedString(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maximum
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareEventToCursor(
	event: ProjectedEvent,
	cursor: RuntimeReadModelCursor,
): number {
	if (event.createdAt !== cursor.t) return event.createdAt < cursor.t ? -1 : 1;
	if (event.runId !== cursor.r) return event.runId - cursor.r;
	return event.eventIndex - cursor.e;
}

function cursorScope(
	organizationId: string,
	agentId: string,
	from: string,
	to: string,
): string {
	return createHash("sha256")
		.update(`${organizationId}\0${agentId}\0${from}\0${to}`)
		.digest("base64url");
}

function encodeCursor(cursor: RuntimeReadModelCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseCursor(
	value: string,
	expectedScope: string,
): RuntimeReadModelCursor {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > MAX_CURSOR_LENGTH
	) {
		throw new RuntimeReadModelValidationError("invalid_cursor");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new RuntimeReadModelValidationError("invalid_cursor");
	}
	if (!isObject(parsed)) {
		throw new RuntimeReadModelValidationError("invalid_cursor");
	}
	const version = parsed.v;
	const runId = parsed.r;
	const eventIndex = parsed.e;
	const createdAt = parsed.t;
	const scope = parsed.s;
	if (
		version !== CURSOR_VERSION ||
		typeof runId !== "number" ||
		!Number.isSafeInteger(runId) ||
		runId <= 0 ||
		typeof eventIndex !== "number" ||
		!Number.isInteger(eventIndex) ||
		eventIndex < 0 ||
		eventIndex > SOURCE_BOUNDARY_EVENT_INDEX ||
		typeof createdAt !== "string" ||
		!parseTimestamp(createdAt) ||
		typeof scope !== "string" ||
		scope !== expectedScope
	) {
		throw new RuntimeReadModelValidationError("invalid_cursor");
	}
	return { v: version, r: runId, e: eventIndex, t: createdAt, s: scope };
}
