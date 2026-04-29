/**
 * `pg.Pool` singleton for callers that need node-postgres specifically
 * (e.g. `@chat-adapter/state-pg`, anything doing raw `LISTEN`).
 *
 * The application's primary client is the `postgres.js` pool exposed by
 * `db/client.ts` — this exists alongside it because `pg` and `postgres.js`
 * use different on-the-wire protocols and can't share a connection. Most
 * code should NOT touch this; reach for `getDb()` first.
 */

import { Pool, type PoolConfig } from 'pg';
import logger from '../utils/logger';

let pgPoolSingleton: Pool | null = null;

function getPgSsl() {
  return process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'prefer'
    ? { rejectUnauthorized: false }
    : undefined;
}

/**
 * Get the singleton `pg.Pool`. Lazily constructed on first call.
 *
 * Pool size is intentionally smaller than the postgres.js pool because the
 * pg.Pool serves a narrow set of clients (state-pg, LISTEN connections) and
 * isn't on the hot path.
 */
export function getPgPool(): Pool {
  if (pgPoolSingleton) return pgPoolSingleton;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to construct pg.Pool');
  }

  const config: PoolConfig = {
    connectionString,
    ssl: getPgSsl(),
    application_name: 'owletto-backend-pg',
    max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
  };

  pgPoolSingleton = new Pool(config);
  pgPoolSingleton.on('error', (err) => {
    logger.warn({ err: String(err) }, '[pg-pool] idle client error');
  });
  logger.info('[pg-pool] singleton constructed');
  return pgPoolSingleton;
}

/**
 * Tear down the pool. Tests use this; production never should.
 */
export async function closePgPool(): Promise<void> {
  if (!pgPoolSingleton) return;
  const pool = pgPoolSingleton;
  pgPoolSingleton = null;
  await pool.end();
}
