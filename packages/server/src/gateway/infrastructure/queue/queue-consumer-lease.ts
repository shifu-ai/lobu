import type { DbClient } from "../../../db/client";

export const QUEUE_CONSUMER_LEASE_TTL_MS = 90_000;
export const QUEUE_CONSUMER_HEARTBEAT_MS = 30_000;

export interface QueueConsumerHeartbeat {
  queueName: string;
  consumerId: string;
  deploymentRevision: string;
  declaredImageDigest: string | null;
  startedAt: Date;
  now: Date;
}

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

export interface QueueConsumerLeaseStore {
  heartbeat(input: QueueConsumerHeartbeat): Promise<void>;
  expire(queueName: string, consumerId: string, now: Date): Promise<void>;
  list(requiredQueues: readonly string[]): Promise<QueueConsumerLeaseFact[]>;
}

export function createPostgresQueueConsumerLeaseStore(
  sql: DbClient
): QueueConsumerLeaseStore {
  return {
    heartbeat: (input) => recordQueueConsumerHeartbeat(sql, input),
    expire: (queueName, consumerId, now) =>
      expireQueueConsumerLease(sql, queueName, consumerId, now),
    async list(requiredQueues) {
      const rows = await sql<any>`
        WITH ranked AS (
          SELECT queue_name, consumer_id, deployment_revision, declared_image_digest,
                 started_at, last_seen_at, lease_expires_at, identity_conflict,
                 row_number() OVER (PARTITION BY queue_name ORDER BY lease_expires_at DESC) AS queue_rank
          FROM public.queue_consumer_leases
          WHERE queue_name = ANY(${requiredQueues as unknown as string[]}::text[])
        )
        SELECT queue_name, consumer_id, deployment_revision, declared_image_digest,
               started_at, last_seen_at, lease_expires_at, identity_conflict
        FROM ranked WHERE queue_rank <= 65
        ORDER BY queue_name, lease_expires_at DESC`;
      return rows.map((row: any) => ({
        queueName: row.queue_name,
        consumerId: row.consumer_id,
        deploymentRevision: row.deployment_revision,
        declaredImageDigest: row.declared_image_digest,
        startedAt: new Date(row.started_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
        identityConflict: row.identity_conflict,
      }));
    },
  };
}

export async function recordQueueConsumerHeartbeat(
  sql: DbClient,
  input: QueueConsumerHeartbeat
): Promise<void> {
  const expiresAt = new Date(input.now.getTime() + QUEUE_CONSUMER_LEASE_TTL_MS);
  await sql`
    INSERT INTO public.queue_consumer_leases (
      queue_name, consumer_id, deployment_revision, declared_image_digest,
      started_at, last_seen_at, lease_expires_at
    ) VALUES (
      ${input.queueName}, ${input.consumerId}, ${input.deploymentRevision}, ${input.declaredImageDigest},
      ${input.startedAt}, ${input.now}, ${expiresAt}
    )
    ON CONFLICT (queue_name, consumer_id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      lease_expires_at = EXCLUDED.lease_expires_at,
      identity_conflict = queue_consumer_leases.identity_conflict OR
        queue_consumer_leases.deployment_revision <> EXCLUDED.deployment_revision OR
        queue_consumer_leases.declared_image_digest IS DISTINCT FROM EXCLUDED.declared_image_digest
  `;
}

export async function expireQueueConsumerLease(
  sql: DbClient,
  queueName: string,
  consumerId: string,
  now = new Date()
): Promise<void> {
  await sql`
    UPDATE public.queue_consumer_leases
    SET last_seen_at = ${now}, lease_expires_at = ${new Date(now.getTime() + 1)}
    WHERE queue_name = ${queueName} AND consumer_id = ${consumerId}
  `;
}
