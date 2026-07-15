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

export async function recordQueueConsumerHeartbeat(
	sql: DbClient,
	input: QueueConsumerHeartbeat,
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
	now = new Date(),
): Promise<void> {
	await sql`
    UPDATE public.queue_consumer_leases
    SET last_seen_at = ${now}, lease_expires_at = ${new Date(now.getTime() + 1)}
    WHERE queue_name = ${queueName} AND consumer_id = ${consumerId}
  `;
}
