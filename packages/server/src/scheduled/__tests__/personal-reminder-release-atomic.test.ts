import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ReleaseCapabilityState } from "@lobu/core";
import { canonicalize } from "json-canonicalize";
import { getDb } from "../../db/client.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { createScheduledJobWithGuards } from "../scheduled-jobs-service.js";

const ORG = "org-personal-reminder-atomic";
const USER = "toolbox-user-atomic";
const AGENT = "shifu-u-personal-reminder-atomic";
const RELEASE_ID = "agent-2026.07.15.1";
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;

beforeAll(async () => ensureDbForGatewayTests());
afterEach(async () => resetTestDatabase());

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

async function seedActiveRelease(): Promise<ReleaseCapabilityState> {
	await seedAgentRow(AGENT, {
		organizationId: ORG,
		ownerPlatform: "toolbox",
		ownerUserId: USER,
	});
	const settingsHash = digest({
		identityMd: "",
		soulMd: "",
		userMd: "",
		modelSelection: {},
		toolsConfig: {},
	});
	const sql = getDb();
	await sql`
		INSERT INTO agent_release_applies (
			organization_id, agent_id, environment,
			desired_release_id, desired_release_sequence, desired_feed_sequence,
			applied_release_id, applied_release_sequence, applied_feed_sequence,
			applied_channel, applied_feed_digest, manifest_digest, status,
			revision_ref, settings_hash
		) VALUES (
			${ORG}, ${AGENT}, 'production',
			${RELEASE_ID}, 1, 1,
			${RELEASE_ID}, 1, 1,
			'stable', ${SNAPSHOT_DIGEST}, ${SNAPSHOT_DIGEST}, 'applied',
			${`lobu:${AGENT}:agent-release:1`}, ${settingsHash}
		)
	`;
	return {
		status: "active",
		claim: {
			environment: "production",
			toolboxUserId: USER,
			agentId: AGENT,
			releaseId: RELEASE_ID,
			releaseSequence: 1,
			snapshotDigest: SNAPSHOT_DIGEST,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			capabilityIds: ["personal_reminder_delivery.v1"],
		},
	};
}

describe("personal reminder release validation and persistence transaction", () => {
	test("an expired replay state cannot create the gated personal reminder", async () => {
		const active = await seedActiveRelease();
		if (active.status !== "active") throw new Error("expected active test state");
		const expired: ReleaseCapabilityState = {
			status: "active",
			claim: {
				...active.claim,
				expiresAt: new Date(Date.now() - 1_000).toISOString(),
			},
		};
		const outcome = await createScheduledJobWithGuards(
			{
				organizationId: ORG,
				actionType: "wake_agent",
				actionArgs: { agent_id: AGENT, prompt: "提醒我回覆客戶" },
				description: "提醒我回覆客戶",
				runAt: new Date(Date.now() + 60_000),
				createdByUser: USER,
				createdByAgent: AGENT,
			},
			{ targetAgentId: AGENT, userId: USER, activeQuota: 20, releaseState: expired },
		);
		expect(outcome).toEqual({ status: "release_inactive" });
		const [{ count }] = await getDb()<{ count: number }>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORG}
		`;
		expect(count).toBe(0);
	});

	test("a concurrent revocation that commits first prevents the waiting reminder write", async () => {
		const releaseState = await seedActiveRelease();
		const sql = getDb();
		let revocationLocked!: () => void;
		const hasRevocationLock = new Promise<void>((resolve) => {
			revocationLocked = resolve;
		});
		let allowRevocationCommit!: () => void;
		const mayCommit = new Promise<void>((resolve) => {
			allowRevocationCommit = resolve;
		});

		const revoke = sql.begin(async (tx) => {
			await tx`
				SELECT id FROM agents
				WHERE organization_id = ${ORG} AND id = ${AGENT}
				FOR UPDATE
			`;
			await tx`
				UPDATE agent_release_applies SET status = 'failed'
				WHERE organization_id = ${ORG} AND agent_id = ${AGENT}
			`;
			revocationLocked();
			await mayCommit;
		});
		await hasRevocationLock;

		const create = createScheduledJobWithGuards(
			{
				organizationId: ORG,
				actionType: "wake_agent",
				actionArgs: { agent_id: AGENT, prompt: "提醒我回覆客戶" },
				description: "提醒我回覆客戶",
				runAt: new Date(Date.now() + 60_000),
				createdByUser: USER,
				createdByAgent: AGENT,
			},
			{ targetAgentId: AGENT, userId: USER, activeQuota: 20, releaseState },
			{ sql },
		);

		// Give the create transaction a turn to reach the agent row lock held
		// by revocation. It must not resolve or insert on stale authorization.
		const beforeCommit = await Promise.race([
			create.then(() => "resolved" as const),
			new Promise<"blocked">((resolve) =>
				setTimeout(() => resolve("blocked"), 25),
			),
		]);
		expect(beforeCommit).toBe("blocked");

		allowRevocationCommit();
		await revoke;
		expect(await create).toEqual({ status: "release_inactive" });
		const [{ count }] = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM scheduled_jobs
			WHERE organization_id = ${ORG}
		`;
		expect(count).toBe(0);
	});
});
