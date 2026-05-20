/**
 * Ephemeral embedded-Postgres backend for tests.
 *
 * Spawns a real PostgreSQL 18 (embedded-postgres) on a throwaway datadir and
 * returns a plain DATABASE_URL any postgres.js client can use — so `make test`
 * needs no external Postgres, exactly like `lobu run`. Same binary + pgvector
 * injection as the production embedded path (src/embedded-runtime.ts), so tests
 * exercise the real engine (prepared statements, multi-conn pool, LISTEN/NOTIFY,
 * cube/earthdistance, pgvector) with no PGlite-specific quirks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectPgvector, resolveEmbeddedNativeDir } from '@lobu/pgvector-embedded';
import EmbeddedPostgres from 'embedded-postgres';

export interface EmbeddedBackend {
  url: string;
  stop: () => Promise<void>;
}

let active: EmbeddedBackend | null = null;

/**
 * Start an ephemeral embedded Postgres and return a connectable DATABASE_URL.
 * Idempotent: repeated calls return the same instance until `stop()` runs.
 */
export async function startEmbeddedBackend(): Promise<EmbeddedBackend> {
  if (active) return active;

  injectPgvector(resolveEmbeddedNativeDir());

  const dataDir = mkdtempSync(join(tmpdir(), 'lobu-test-pg-'));
  // 0 lets the OS assign; embedded-postgres needs a concrete port, so pick a
  // high random one and let a collision fail loudly rather than silently share.
  const port = 50000 + Math.floor(Math.random() * 10000);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  active = {
    url,
    stop: async () => {
      try {
        await pg.stop();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
        active = null;
      }
    },
  };
  return active;
}
