/**
 * Postgres advisory lock helper for the identity engine.
 *
 * Two simultaneous sign-ins for the same provider account can both load
 * prior facts, both pass the existing-relationship check, and both insert
 * new facts/derivations — a textbook lost-update race. Pi P0.3.
 *
 * Resolution: serialise concurrent ingest passes for the same
 * (connectorKey, providerStableId) tuple. The lock is session-scoped
 * (pg_advisory_lock + pg_advisory_unlock) and held in a try/finally so an
 * exception inside the work doesn't leave the lock dangling.
 *
 * Postgres advisory locks take a bigint key; we hash the string identity
 * into 63 bits (the high bit is reserved by postgres for keyspace split).
 */

import { createHash } from 'node:crypto';
import { getDb } from '../db/client';

type Sql = ReturnType<typeof getDb>;

const POSTGRES_BIGINT_MAX_POSITIVE = (1n << 63n) - 1n;

/**
 * Convert a string to a stable 63-bit positive bigint suitable for
 * pg_advisory_lock. Uses the first 8 bytes of sha256(input).
 */
function stringToLockKey(input: string): bigint {
  const digest = createHash('sha256').update(input).digest();
  let key = 0n;
  for (let i = 0; i < 8; i++) {
    key = (key << 8n) | BigInt(digest[i]);
  }
  return key & POSTGRES_BIGINT_MAX_POSITIVE;
}

export function lockKeyForAccount(connectorKey: string, providerStableId: string): bigint {
  return stringToLockKey(`identity-engine:${connectorKey}:${providerStableId}`);
}

/**
 * Run `fn` while holding a session-level advisory lock for the given
 * account identity. Re-throws after releasing the lock if `fn` fails.
 */
export async function withAccountLock<T>(
  connectorKey: string,
  providerStableId: string,
  fn: () => Promise<T>
): Promise<T> {
  const sql: Sql = getDb();
  const key = lockKeyForAccount(connectorKey, providerStableId);
  // postgres.js renders a JS bigint as a numeric literal in the prepared
  // statement, which Postgres will accept as bigint.
  await sql`SELECT pg_advisory_lock(${key})`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${key})`;
  }
}
