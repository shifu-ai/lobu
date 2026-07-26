import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { type DbClient, getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import {
	RuntimeReadModelValidationError,
	readRuntimeReadModelEvents,
} from "../runtime-read-model-export.js";
import { createRuntimeReadModelRoutes } from "../runtime-read-model-routes.js";
import { orgContext } from "../stores/org-context.js";
import { installRouteAuthTestMock } from "./helpers/route-test-mocks.js";

installRouteAuthTestMock();

const ORGANIZATION_ID = "org-runtime-read-model";
const OTHER_ORGANIZATION_ID = "org-runtime-read-model-other";
const AGENT_ID = "shifu-u-user-1";
const OTHER_AGENT_ID = "shifu-u-user-2";
const FROM = "2026-07-26T00:00:00.000Z";
const TO = "2026-07-27T00:00:00.000Z";
const LOOKUP_MIGRATION = path.resolve(
	__dirname,
	"../../../../../db/migrations/20260727120000_runtime_read_model_line_lookup.sql",
);

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	await seedOrg(ORGANIZATION_ID);
	await seedOrg(OTHER_ORGANIZATION_ID);
	await seedAgentRow(AGENT_ID, { organizationId: ORGANIZATION_ID });
	await seedRuns();
});

describe("durable runtime read-model repair event export", () => {
	test("pins the bounded LINE message lookup index migration", () => {
		const migration = fs.readFileSync(LOOKUP_MIGRATION, "utf8");
		expect(migration).toContain("-- migrate:up transaction:false");
		expect(migration).toContain(
			"CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_runtime_read_model_line_message_lookup",
		);
		expect(migration).toMatch(
			/organization_id,\s*\(action_input ->> 'agentId'\),\s*\(action_input ->> 'messageId'\),\s*created_at,\s*id/,
		);
		expect(migration).toContain(
			"queue_name LIKE 'thread_message\\_%' ESCAPE '\\'",
		);
		expect(migration).toContain("action_input ->> 'platform' = 'line'");
		expect(migration).toContain("-- migrate:down transaction:false");
		expect(migration).toContain(
			"DROP INDEX CONCURRENTLY IF EXISTS public.runs_runtime_read_model_line_message_lookup",
		);
		expect(migration).toMatch(/operational cost:.*not yet measured/i);
	});
	test("exports the bounded projection through the organization-scoped admin PAT route", async () => {
		const app = await buildProvisioningApp();
		const response = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/runtime-read-model-events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			events: [
				{
					type: "line_inbound",
					toolboxUserId: "toolbox-user-1",
					lineUserId: null,
					agentId: AGENT_ID,
					lobuConversationId: "conv-1",
					content: "Please repair this runtime read model.",
					messageId: "line-message-1",
					eventId: null,
					roundId: null,
					decisionId: null,
					submittedValue: null,
					submittedAt: null,
					occurredAt: "2026-07-26T01:00:00.000Z",
				},
				{
					type: "assistant_complete",
					toolboxUserId: "toolbox-user-1",
					lineUserId: null,
					agentId: AGENT_ID,
					lobuConversationId: "conv-1",
					content: "The durable repair is complete.",
					messageId: "line-message-1",
					eventId: null,
					roundId: null,
					decisionId: null,
					submittedValue: null,
					submittedAt: null,
					occurredAt: "2026-07-26T01:00:00.000Z",
				},
			],
			nextCursor: null,
			quarantined: 1,
		});
	});

	test("requires an organization-scoped mcp admin PAT at the route boundary", async () => {
		const app = await buildProvisioningApp([]);
		const response = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/runtime-read-model-events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2`,
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "forbidden",
			error_description:
				"Provisioning requires an organization-scoped PAT with mcp:admin scope.",
		});
	});

	test("returns stable route validation errors without source data", async () => {
		const app = await buildProvisioningApp();
		const invalidCursor = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/runtime-read-model-events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2&cursor=bad`,
		);
		expect(invalidCursor.status).toBe(400);
		expect(await invalidCursor.json()).toEqual({ error: "invalid_cursor" });

		const invalidLimit = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/runtime-read-model-events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=201`,
		);
		expect(invalidLimit.status).toBe(400);
		expect(await invalidLimit.json()).toEqual({ error: "invalid_limit" });
	});

	test("does not leak another organization's durable rows through the route", async () => {
		const app = await buildProvisioningApp(
			["mcp:admin"],
			OTHER_ORGANIZATION_ID,
		);
		const response = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/runtime-read-model-events?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=2`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			events: [],
			nextCursor: null,
			quarantined: 0,
		});
	});

	test("projects only matching LINE inbound and durable completion events", async () => {
		const result = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 2,
		});

		expect(result).toEqual({
			events: [
				{
					type: "line_inbound",
					toolboxUserId: "toolbox-user-1",
					lineUserId: null,
					agentId: AGENT_ID,
					lobuConversationId: "conv-1",
					content: "Please repair this runtime read model.",
					messageId: "line-message-1",
					eventId: null,
					roundId: null,
					decisionId: null,
					submittedValue: null,
					submittedAt: null,
					occurredAt: "2026-07-26T01:00:00.000Z",
				},
				{
					type: "assistant_complete",
					toolboxUserId: "toolbox-user-1",
					lineUserId: null,
					agentId: AGENT_ID,
					lobuConversationId: "conv-1",
					content: "The durable repair is complete.",
					messageId: "line-message-1",
					eventId: null,
					roundId: null,
					decisionId: null,
					submittedValue: null,
					submittedAt: null,
					occurredAt: "2026-07-26T01:00:00.000Z",
				},
			],
			nextCursor: null,
			quarantined: 1,
		});
	});

	test("keeps another organization and another agent out of the projection", async () => {
		const result = await readRuntimeReadModelEvents({
			organizationId: OTHER_ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 200,
		});
		expect(result).toEqual({ events: [], nextCursor: null, quarantined: 0 });

		const otherAgent = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: OTHER_AGENT_ID,
			from: FROM,
			to: TO,
			limit: 200,
		});
		expect(otherAgent).toEqual({
			events: [],
			nextCursor: null,
			quarantined: 0,
		});
	});

	test("rejects invalid cursors, limits, ids, timestamps, and windows without source detail", async () => {
		for (const input of [
			{ cursor: "not-a-cursor" },
			{ limit: 201 },
			{ agentId: "lobu-test" },
			{ from: "not-a-timestamp" },
			{ to: "2026-08-27T00:00:00.001Z" },
		] as const) {
			expect(
				readRuntimeReadModelEvents({
					organizationId: ORGANIZATION_ID,
					agentId: AGENT_ID,
					from: FROM,
					to: TO,
					limit: 2,
					...input,
				}),
			).rejects.toBeInstanceOf(RuntimeReadModelValidationError);
		}
	});

	test("paginates tied timestamps without duplicating or skipping events", async () => {
		const first = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 1,
		});
		expect(first.events).toHaveLength(1);
		expect(first.nextCursor).toEqual(expect.any(String));

		const second = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 1,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.events).toHaveLength(1);
		expect(second.events[0]?.type).toBe("assistant_complete");
		expect(second.nextCursor).toBeNull();
	});

	test("quarantines oversized source content instead of truncating it", async () => {
		const sql = getDb();
		await sql`
			INSERT INTO public.runs (
				organization_id, run_type, queue_name, action_input, status, run_at, created_at
			) VALUES (
				${ORGANIZATION_ID}, 'chat_message', 'thread_message_lobu-worker-1',
				${sql.json({
					messageId: "oversized-line-message",
					messageText: "x".repeat(16 * 1024 + 1),
					userId: "toolbox-user-1",
					agentId: AGENT_ID,
					conversationId: "conv-1",
					platform: "line",
				})},
				'completed', ${"2026-07-26T06:00:00.000Z"}, ${"2026-07-26T06:00:00.000Z"}
			)
		`;
		const result = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 200,
		});
		expect(result.events.map((event) => event.messageId)).not.toContain(
			"oversized-line-message",
		);
		expect(result.quarantined).toBe(2);
	});

	test("ignores unrelated and legacy-unproven responses but quarantines unmapped LINE responses", async () => {
		const sql = getDb();
		await insertRuntimeRun(
			sql,
			"thread_response",
			{
				platform: "web",
				processedMessageIds: ["line-message-1"],
				finalText: "Web response must stay private.",
				userId: "toolbox-user-1",
				agentId: AGENT_ID,
				conversationId: "conv-1",
			},
			"2026-07-26T06:10:00.000Z",
		);
		await insertRuntimeRun(
			sql,
			"thread_response",
			{
				platform: "slack",
				processedMessageIds: ["line-message-1"],
				finalText: "Slack response must stay private.",
				userId: "toolbox-user-1",
				agentId: AGENT_ID,
				conversationId: "conv-1",
			},
			"2026-07-26T06:11:00.000Z",
		);
		await insertRuntimeRun(
			sql,
			"thread_response",
			{
				processedMessageIds: ["legacy-unmatched"],
				finalText: "Legacy unproven response.",
				userId: "toolbox-user-1",
				agentId: AGENT_ID,
				conversationId: "conv-1",
			},
			"2026-07-26T06:12:00.000Z",
		);
		await insertRuntimeRun(
			sql,
			"thread_response",
			{
				platform: "line",
				processedMessageIds: ["line-unmatched"],
				finalText: "LINE response without proof.",
				userId: "toolbox-user-1",
				agentId: AGENT_ID,
				conversationId: "conv-1",
			},
			"2026-07-26T06:13:00.000Z",
		);

		const result = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 200,
		});
		expect(result.events).toHaveLength(2);
		expect(result.events.map((event) => event.content)).not.toContain(
			"Web response must stay private.",
		);
		expect(result.events.map((event) => event.content)).not.toContain(
			"Slack response must stay private.",
		);
		expect(result.quarantined).toBe(2);
	});

	test("permanently quarantines triplicate LINE message ids and their legacy completion", async () => {
		const sql = getDb();
		for (const createdAt of [
			"2026-07-26T07:00:00.000Z",
			"2026-07-26T07:01:00.000Z",
			"2026-07-26T07:02:00.000Z",
		]) {
			await insertRuntimeRun(
				sql,
				"thread_message_lobu-worker-1",
				{
					messageId: "triplicate-line-message",
					messageText: "Duplicate source",
					userId: "toolbox-user-1",
					agentId: AGENT_ID,
					conversationId: "conv-1",
					platform: "line",
				},
				createdAt,
			);
		}
		await insertRuntimeRun(
			sql,
			"thread_response",
			{
				processedMessageIds: ["triplicate-line-message"],
				finalText: "Must not be projected.",
				userId: "toolbox-user-1",
				agentId: AGENT_ID,
				conversationId: "conv-1",
			},
			"2026-07-26T07:03:00.000Z",
		);

		const result = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 200,
		});
		expect(result.events.map((event) => event.messageId)).not.toContain(
			"triplicate-line-message",
		);
		expect(result.quarantined).toBe(5);
	});

	test("uses a bounded keyset source batch and resumes from its cursor", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const rows = [
			{
				run_id: 11,
				created_at: new Date("2026-07-26T01:00:00.000Z"),
				queue_name: "thread_message_lobu-worker-1",
				action_input: {
					messageId: "batch-message-1",
					messageText: "Bounded source",
					userId: "toolbox-user-1",
					agentId: AGENT_ID,
					conversationId: "conv-1",
					platform: "line",
				},
			},
			{
				run_id: 12,
				created_at: new Date("2026-07-26T01:00:01.000Z"),
				queue_name: "thread_response",
				action_input: {
					processedMessageIds: ["batch-message-1"],
					finalText: "Bounded completion",
					userId: "toolbox-user-1",
					agentId: AGENT_ID,
					conversationId: "conv-1",
				},
			},
		];
		const fakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?");
			calls.push({ text, values });
			if (text.includes("LATERAL")) {
				return Promise.resolve([
					{
						message_id: "batch-message-1",
						match_count: 1,
						run_id: 11,
						created_at: new Date("2026-07-26T01:00:00.000Z"),
						queue_name: "thread_message_lobu-worker-1",
						action_input: rows[0]?.action_input,
					},
				]);
			}
			return Promise.resolve(rows);
		}) as unknown as DbClient;

		const first = await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 1,
			sql: fakeSql,
		});
		expect(first.nextCursor).toEqual(expect.any(String));
		const sourceCall = calls[0];
		expect(sourceCall?.text).toContain("LIMIT ?");
		expect(sourceCall?.values.at(-1)).toBeGreaterThanOrEqual(1);
		expect(calls.some((call) => call.text.includes("LATERAL"))).toBe(true);
		expect(calls.some((call) => call.text.includes("LIMIT 2"))).toBe(true);
		expect(calls.some((call) => call.text.includes("GROUP BY"))).toBe(false);

		await readRuntimeReadModelEvents({
			organizationId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			from: FROM,
			to: TO,
			limit: 1,
			cursor: first.nextCursor ?? undefined,
			sql: fakeSql,
		});
		const sourceCalls = calls.filter(
			(call) =>
				call.text.includes("FROM public.runs") &&
				!call.text.includes("LATERAL"),
		);
		expect(sourceCalls).toHaveLength(2);
		expect(sourceCalls[1]?.text).toContain("id >= ?");
	});
});

async function buildProvisioningApp(
  scopes: string[] = ["mcp:admin"],
  organizationId = ORGANIZATION_ID,
) {
  const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("session", { id: "pat:runtime-read-model-test" });
		c.set("organizationId", organizationId);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes });
		return orgContext.run({ organizationId }, next);
  });
  app.route("/api/provisioning", createRuntimeReadModelRoutes());
  return app;
}

async function seedOrg(organizationId: string): Promise<void> {
	const sql = getDb();
	await sql`
		INSERT INTO organization (id, name, slug)
		VALUES (${organizationId}, ${organizationId}, ${organizationId})
	`;
}

async function seedRuns(): Promise<void> {
	const sql = getDb();
	const insert = async (
		organizationId: string,
		queueName: string,
		actionInput: Record<string, unknown> | string,
		createdAt: string,
	) => sql`
		INSERT INTO public.runs (
			organization_id, run_type, queue_name, action_input, status, run_at, created_at
		) VALUES (
			${organizationId}, 'chat_message', ${queueName}, ${sql.json(actionInput)},
			'completed', ${createdAt}, ${createdAt}
		)
	`;

	await insert(
		ORGANIZATION_ID,
		"thread_message_lobu-worker-1",
		{
			messageId: "line-message-1",
			messageText: "Please repair this runtime read model.",
			userId: "toolbox-user-1",
			agentId: AGENT_ID,
			conversationId: "conv-1",
			platform: "line",
		},
		"2026-07-26T01:00:00.000Z",
	);
	await insert(
		ORGANIZATION_ID,
		"thread_response",
		{
			processedMessageIds: ["line-message-1"],
			finalText: "The durable repair is complete.",
			userId: "toolbox-user-1",
			agentId: AGENT_ID,
			conversationId: "conv-1",
		},
		"2026-07-26T01:00:00.000Z",
	);
	await insert(
		ORGANIZATION_ID,
		"thread_message_lobu-worker-1",
		{
			messageId: "web-message-1",
			messageText: "Web only",
			userId: "toolbox-user-1",
			agentId: AGENT_ID,
			conversationId: "conv-1",
			platform: "web",
		},
		"2026-07-26T02:00:00.000Z",
	);
	await insert(
		ORGANIZATION_ID,
		"thread_message_lobu-worker-1",
		{
			messageId: "other-agent-message-1",
			messageText: "Other agent",
			userId: "toolbox-user-1",
			agentId: OTHER_AGENT_ID,
			conversationId: "conv-2",
			platform: "line",
		},
		"2026-07-26T03:00:00.000Z",
	);
	await insert(
		OTHER_ORGANIZATION_ID,
		"thread_message_lobu-worker-1",
		{
			messageId: "other-org-message-1",
			messageText: "Other organization",
			userId: "toolbox-user-1",
			agentId: AGENT_ID,
			conversationId: "conv-1",
			platform: "line",
		},
		"2026-07-26T04:00:00.000Z",
	);
	await insert(
		ORGANIZATION_ID,
		"thread_message_lobu-worker-1",
		{ agentId: AGENT_ID, platform: "line", messageText: "malformed" },
		"2026-07-26T05:00:00.000Z",
	);
}

async function insertRuntimeRun(
	sql: DbClient,
	queueName: string,
	actionInput: Record<string, unknown>,
	createdAt: string,
): Promise<void> {
	await sql`
		INSERT INTO public.runs (
			organization_id, run_type, queue_name, action_input, status, run_at, created_at
		) VALUES (
			${ORGANIZATION_ID}, 'chat_message', ${queueName}, ${sql.json(actionInput)},
			'completed', ${createdAt}, ${createdAt}
		)
	`;
}
