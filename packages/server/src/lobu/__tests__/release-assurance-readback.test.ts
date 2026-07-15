import { describe, expect, it } from "vitest";
import {
	canonicalToolInventory,
	evaluateQueueConsumerReadiness,
	type QueueConsumerLeaseFact,
	readAgentCapabilitySnapshotTruth,
} from "../release-assurance-readback";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

function lease(
	overrides: Partial<QueueConsumerLeaseFact> = {},
): QueueConsumerLeaseFact {
	return {
		queueName: "messages",
		consumerId: "consumer-a",
		deploymentRevision: "rev-1",
		declaredImageDigest: DIGEST,
		startedAt: "2026-07-15T09:55:00.000Z",
		lastSeenAt: "2026-07-15T09:59:45.000Z",
		leaseExpiresAt: "2026-07-15T10:01:00.000Z",
		identityConflict: false,
		...overrides,
	};
}

describe("bounded queue consumer readiness", () => {
	it("is red when a producer exists but no required consumer is active", () => {
		expect(evaluateQueueConsumerReadiness([], ["messages"], NOW)).toMatchObject(
			{
				status: "red",
				reasonCodes: ["consumer_missing"],
			},
		);
	});

	it("is red when the only consumer lease is stale", () => {
		expect(
			evaluateQueueConsumerReadiness(
				[lease({ leaseExpiresAt: "2026-07-15T09:59:59.000Z" })],
				["messages"],
				NOW,
			),
		).toMatchObject({ status: "red", reasonCodes: ["consumer_stale"] });
	});

	it("accepts multiple distinct homogeneous replica consumers", () => {
		expect(
			evaluateQueueConsumerReadiness(
				[lease(), lease({ consumerId: "consumer-b" })],
				["messages"],
				NOW,
			),
		).toMatchObject({
			status: "green",
			activeConsumerCount: 2,
			reasonCodes: [],
		});
	});

	it("is red for duplicate/conflicting consumer identity", () => {
		expect(
			evaluateQueueConsumerReadiness(
				[lease({ identityConflict: true })],
				["messages"],
				NOW,
			),
		).toMatchObject({
			status: "red",
			reasonCodes: ["consumer_identity_conflict"],
		});
	});

	it("is red when active replicas are heterogeneous across revision or declared image", () => {
		expect(
			evaluateQueueConsumerReadiness(
				[
					lease(),
					lease({ consumerId: "consumer-b", deploymentRevision: "rev-2" }),
				],
				["messages"],
				NOW,
			),
		).toMatchObject({
			status: "red",
			reasonCodes: ["consumer_carrier_mismatch"],
		});
	});
});

describe("bounded durable MCP tool inventory", () => {
	it("projects only sorted unique canonical names and a stable fingerprint", () => {
		const inventory = canonicalToolInventory([
			"docs_create",
			"calendar_events_list",
			"docs_create",
		]);
		expect(inventory.names).toEqual(["calendar_events_list", "docs_create"]);
		expect(inventory.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			canonicalToolInventory([...inventory.names].reverse()).fingerprint,
		).toBe(inventory.fingerprint);
	});

	it("rejects unbounded or unsafe names instead of storing tool schemas", () => {
		expect(() => canonicalToolInventory(["valid", "bad name"])).toThrow(
			/tool name/i,
		);
		expect(() =>
			canonicalToolInventory(
				Array.from({ length: 257 }, (_, index) => `tool_${index}`),
			),
		).toThrow(/bounded/i);
	});
});

describe("durable accepted capability snapshot readback", () => {
	it("returns the exact unexpired snapshot bound to the current apply identity", async () => {
		const sql = (async () => [
			{
				release_id: "release-3",
				release_sequence: 3,
				snapshot_digest: `sha256:${"c".repeat(64)}`,
				capability_ids: ["personal_reminder_delivery.v1"],
				observed_at: "2026-07-15T10:00:00.000Z",
				expires_at: "2026-07-15T10:01:00.000Z",
			},
		]) as never;
		await expect(
			readAgentCapabilitySnapshotTruth(
				{ organizationId: "org-1", agentId: "agent-1" },
				sql,
			),
		).resolves.toMatchObject({
			releaseId: "release-3",
			releaseSequence: 3,
			snapshotDigest: `sha256:${"c".repeat(64)}`,
			capabilityIds: ["personal_reminder_delivery.v1"],
		});
	});
});
