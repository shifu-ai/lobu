import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { type DbClient, getDb } from "../db/client";
import { getRuntimeInfo } from "../utils/runtime-info";

export const REQUIRED_RELEASE_QUEUE_NAMES = [
	"messages",
	"thread_response",
	"task",
] as const;

export interface QueueConsumerLeaseFact {
	queueName: string;
	consumerId: string;
	deploymentRevision: string;
	declaredImageDigest: string | null;
	startedAt: string;
	lastSeenAt: string;
	leaseExpiresAt: string;
	identityConflict: boolean;
}

export interface QueueConsumerReadiness {
	status: "green" | "red";
	reasonCodes: Array<
		| "consumer_missing"
		| "consumer_stale"
		| "consumer_identity_conflict"
		| "consumer_carrier_mismatch"
		| "consumer_runtime_mismatch"
	>;
	requiredQueues: readonly string[];
	activeConsumerCount: number;
	consumers: QueueConsumerLeaseFact[];
}

export function evaluateQueueConsumerReadiness(
	facts: QueueConsumerLeaseFact[],
	requiredQueues: readonly string[],
	now = new Date(),
	servingIdentity?: { revision: string; declaredImageDigest: string | null },
): QueueConsumerReadiness {
	const relevant = facts.filter((fact) =>
		requiredQueues.includes(fact.queueName),
	);
	const active = relevant.filter(
		(fact) => Date.parse(fact.leaseExpiresAt) > now.getTime(),
	);
	const reasons = new Set<QueueConsumerReadiness["reasonCodes"][number]>();
	for (const queueName of requiredQueues) {
		const queueFacts = relevant.filter((fact) => fact.queueName === queueName);
		if (queueFacts.length === 0) reasons.add("consumer_missing");
		else if (
			!queueFacts.some(
				(fact) => Date.parse(fact.leaseExpiresAt) > now.getTime(),
			)
		) {
			reasons.add("consumer_stale");
		}
	}
	if (active.some((fact) => fact.identityConflict))
		reasons.add("consumer_identity_conflict");
	const carriers = new Set(
		active.map(
			(fact) => `${fact.deploymentRevision}\0${fact.declaredImageDigest ?? ""}`,
		),
	);
	if (carriers.size > 1) reasons.add("consumer_carrier_mismatch");
	if (servingIdentity && active.some((fact) =>
		fact.deploymentRevision !== servingIdentity.revision ||
		fact.declaredImageDigest !== servingIdentity.declaredImageDigest)) {
		reasons.add("consumer_runtime_mismatch");
	}
	return {
		status: reasons.size === 0 ? "green" : "red",
		reasonCodes: [...reasons],
		requiredQueues: [...requiredQueues],
		activeConsumerCount: active.length,
		consumers: relevant.slice(0, 64),
	};
}

interface QueueLeaseRow {
	queue_name: string;
	consumer_id: string;
	deployment_revision: string;
	declared_image_digest: string | null;
	started_at: Date | string;
	last_seen_at: Date | string;
	lease_expires_at: Date | string;
	identity_conflict: boolean;
}

function iso(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

export async function readQueueConsumerReadiness(
	sql: DbClient = getDb(),
	now = new Date(),
) {
	const runtime = getRuntimeInfo();
	const rows = await sql<QueueLeaseRow>`
    WITH ranked AS (
      SELECT queue_name, consumer_id, deployment_revision, declared_image_digest,
             started_at, last_seen_at, lease_expires_at, identity_conflict,
             row_number() OVER (PARTITION BY queue_name ORDER BY lease_expires_at DESC) AS queue_rank
      FROM public.queue_consumer_leases
      WHERE queue_name = ANY(${REQUIRED_RELEASE_QUEUE_NAMES as unknown as string[]}::text[])
    )
    SELECT queue_name, consumer_id, deployment_revision, declared_image_digest,
           started_at, last_seen_at, lease_expires_at, identity_conflict
    FROM ranked WHERE queue_rank <= 65
    ORDER BY queue_name, lease_expires_at DESC
  `;
	const result = evaluateQueueConsumerReadiness(
		rows.map((row) => ({
			queueName: row.queue_name,
			consumerId: row.consumer_id,
			deploymentRevision: row.deployment_revision,
			declaredImageDigest: row.declared_image_digest,
			startedAt: iso(row.started_at),
			lastSeenAt: iso(row.last_seen_at),
			leaseExpiresAt: iso(row.lease_expires_at),
			identityConflict: row.identity_conflict,
		})),
		REQUIRED_RELEASE_QUEUE_NAMES,
		now,
		{ revision: runtime.revision, declaredImageDigest: runtime.declared_image_digest },
	);
	if (REQUIRED_RELEASE_QUEUE_NAMES.some((queueName) =>
		rows.filter((row) => row.queue_name === queueName).length > 64)) {
		return { ...result, status: "red" as const,
			reasonCodes: [...new Set([...result.reasonCodes, "consumer_carrier_mismatch" as const])] };
	}
	return result;
}

export async function readMigrationTruth(
	sql: DbClient = getDb(),
	observedAt = new Date(),
) {
	const rows = await sql<{ version: string }>`
    SELECT version FROM public.schema_migrations ORDER BY version ASC LIMIT 257
  `;
	const overflow = rows.length > 256;
	const versions = rows.slice(0, 256).map((row) => String(row.version));
	const historyDigest = digest(versions);
	const databaseIdentityDigest = digest(
		databaseIdentitySubject(process.env.DATABASE_URL),
	);
	return {
		status: versions.length > 0 && !overflow ? ("green" as const) : ("red" as const),
		databaseIdentityDigest,
		appliedVersions: versions,
		historyDigest,
		observedAt: observedAt.toISOString(),
	};
}

function databaseIdentitySubject(databaseUrl: string | undefined): string {
	if (!databaseUrl) return "database:unconfigured";
	try {
		const url = new URL(databaseUrl);
		return `postgres:${url.hostname.toLowerCase()}:${url.port || "5432"}:${url.pathname.replace(/^\//, "")}`;
	} catch {
		return "database:invalid";
	}
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function canonicalToolInventory(input: readonly string[]) {
	if (input.length > 256)
		throw new Error("MCP tool inventory must remain bounded");
	const names = [...new Set(input.map((name) => name.trim()))].sort();
	if (
		names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(name))
	) {
		throw new Error("MCP tool name is invalid");
	}
	return { names, fingerprint: digest(names) };
}

export async function recordAgentEffectiveToolInventoryTruth(
	input: {
		organizationId: string;
		agentId: string;
		releaseId: string;
		releaseSequence: number;
		capabilitySnapshotDigest: string;
		snapshotAuthority: string;
		toolNames: readonly string[];
		fingerprint: string;
		observedAt?: Date;
		expiresAt?: Date;
	},
	sql: DbClient = getDb(),
): Promise<void> {
	const inventory = canonicalToolInventory(input.toolNames);
	if (!/^sha256:[0-9a-f]{64}$/.test(input.fingerprint)) throw new Error("effective inventory fingerprint is invalid");
	const observedAt = input.observedAt ?? new Date();
	const expiresAt = input.expiresAt ?? new Date(observedAt.getTime() + 5 * 60_000);
	await sql`
    INSERT INTO public.agent_effective_tool_inventory_snapshots (
      organization_id, agent_id, release_id, release_sequence, capability_snapshot_digest,
      snapshot_authority, tool_names, inventory_fingerprint, observed_at, expires_at
    ) VALUES (
      ${input.organizationId}, ${input.agentId}, ${input.releaseId}, ${input.releaseSequence},
      ${input.capabilitySnapshotDigest}, ${input.snapshotAuthority}, ${sql.json(inventory.names)},
		${input.fingerprint}, ${observedAt}, ${expiresAt}
    )
    ON CONFLICT (organization_id, agent_id, snapshot_authority) DO UPDATE SET
      release_id = EXCLUDED.release_id,
      release_sequence = EXCLUDED.release_sequence,
      capability_snapshot_digest = EXCLUDED.capability_snapshot_digest,
      tool_names = EXCLUDED.tool_names,
      inventory_fingerprint = EXCLUDED.inventory_fingerprint,
      observed_at = EXCLUDED.observed_at,
      expires_at = EXCLUDED.expires_at
  `;
}

export async function readRuntimeReleaseAssurance(
	sql: DbClient = getDb(),
	now = new Date(),
) {
	const runtime = getRuntimeInfo();
	const [queueConsumer, migration] = await Promise.all([
		readQueueConsumerReadiness(sql, now),
		readMigrationTruth(sql, now),
	]);
	return {
		schemaVersion: 1 as const,
		service: "lobu-runtime" as const,
		environment: runtime.environment,
		revision: runtime.revision,
		buildTime: runtime.build_time,
		declaredImageDigest: runtime.declared_image_digest,
		buildIdentityStatus: runtime.build_identity_status,
		buildIdentityDigest: runtime.build_identity_digest,
		buildSource: "github:shifu-ai/lobu",
		capabilities: ["agent-release.readiness.v1"],
		queueConsumer,
		migration,
		observedAt: now.toISOString(),
	};
}

export async function readAgentToolInventoryTruth(
	input: { organizationId: string; agentId: string },
	sql: DbClient = getDb(),
) {
	const rows = await sql<{
		tool_names: unknown;
		inventory_fingerprint: string;
		release_id: string;
		release_sequence: number | string;
		capability_snapshot_digest: string;
		observed_at: Date | string;
		expires_at: Date | string;
	}>`
    SELECT i.tool_names, i.inventory_fingerprint, i.release_id, i.release_sequence,
           i.capability_snapshot_digest, i.observed_at, i.expires_at
    FROM public.agent_effective_tool_inventory_snapshots i
    JOIN public.agent_release_applies r
      ON r.organization_id = i.organization_id AND r.agent_id = i.agent_id
     AND r.applied_release_id = i.release_id AND r.applied_release_sequence = i.release_sequence
    JOIN public.agent_release_capability_snapshots c
      ON c.organization_id = i.organization_id AND c.agent_id = i.agent_id
     AND c.release_id = i.release_id AND c.release_sequence = i.release_sequence
     AND c.snapshot_digest = i.capability_snapshot_digest
    WHERE i.organization_id = ${input.organizationId} AND i.agent_id = ${input.agentId}
      AND r.status = 'applied' AND i.expires_at > now() AND c.expires_at > now()
    ORDER BY i.observed_at DESC
    LIMIT 1
  `;
	if (rows.length === 0)
		return {
			status: "missing" as const,
			names: [] as string[],
			fingerprint: null,
			observedAt: null,
			expiresAt: null,
			releaseId: null,
			releaseSequence: null,
			capabilitySnapshotDigest: null,
		};
	const rawNames = rows
		.flatMap((row) => (Array.isArray(row.tool_names) ? row.tool_names : []))
		.filter((name): name is string => typeof name === "string");
	try {
		const inventory = canonicalToolInventory(rawNames);
		if (!/^sha256:[0-9a-f]{64}$/.test(rows[0]!.inventory_fingerprint)) throw new Error("invalid fingerprint");
		return {
			status: "available" as const,
			names: inventory.names,
			fingerprint: rows[0]!.inventory_fingerprint,
			releaseId: rows[0]!.release_id,
			releaseSequence: Number(rows[0]!.release_sequence),
			capabilitySnapshotDigest: rows[0]!.capability_snapshot_digest,
			observedAt: iso(rows[0]!.observed_at),
			expiresAt: iso(rows[0]!.expires_at),
		};
	} catch {
		return { status: "missing" as const, names: [] as string[], fingerprint: null, observedAt: null,
			expiresAt: null, releaseId: null, releaseSequence: null, capabilitySnapshotDigest: null };
	}
}

export async function readAgentCapabilitySnapshotTruth(
	input: { organizationId: string; agentId: string },
	sql: DbClient = getDb(),
) {
	const rows = await sql<{
		release_id: string;
		release_sequence: number | string;
		snapshot_digest: string;
		capability_ids: unknown;
		observed_at: Date | string;
		expires_at: Date | string;
	}>`
    SELECT s.release_id, s.release_sequence, s.snapshot_digest, s.capability_ids,
           s.observed_at, s.expires_at
    FROM public.agent_release_capability_snapshots s
    JOIN public.agent_release_applies r
      ON r.organization_id = s.organization_id AND r.agent_id = s.agent_id
     AND r.applied_release_id = s.release_id AND r.applied_release_sequence = s.release_sequence
    WHERE s.organization_id = ${input.organizationId} AND s.agent_id = ${input.agentId}
      AND s.expires_at > now() AND r.status = 'applied'
    ORDER BY s.observed_at DESC
    LIMIT 1
  `;
	const row = rows[0];
	if (!row) return null;
	return {
		releaseId: row.release_id,
		releaseSequence: Number(row.release_sequence),
		snapshotDigest: row.snapshot_digest,
		capabilityIds: Array.isArray(row.capability_ids)
			? row.capability_ids
					.filter((value): value is string => typeof value === "string")
					.slice(0, 64)
			: [],
		observedAt: iso(row.observed_at),
		expiresAt: iso(row.expires_at),
	};
}

export function createReleaseAssuranceReadback(input: {
	sql?: DbClient;
	findAgentBase(query: { organizationId: string; agentId: string }): Promise<{
		managedReleaseReceipt: unknown;
		liveManagedSettingsDigest: string | null;
	} | null>;
	now?: () => Date;
}) {
	const sql = () => input.sql ?? getDb();
	return {
		readRuntime: () => readRuntimeReleaseAssurance(sql(), input.now?.() ?? new Date()),
		readAgent: async (query: { organizationId: string; agentId: string }) => {
			const base = await input.findAgentBase(query);
			if (!base) return null;
			const [inventory, capabilitySnapshot] = await Promise.all([
				readAgentToolInventoryTruth(query, sql()), readAgentCapabilitySnapshotTruth(query, sql()),
			]);
			return { schemaVersion: 1 as const, agentId: query.agentId, ...base,
				capabilitySnapshotDigest: capabilitySnapshot?.snapshotDigest ?? null,
				effectiveMcpToolInventory: inventory,
				observedAt: (input.now?.() ?? new Date()).toISOString() };
		},
	};
}
