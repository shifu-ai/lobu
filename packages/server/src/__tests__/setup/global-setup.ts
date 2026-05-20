/**
 * Global Test Setup
 *
 * Runs once before all tests. One backend story:
 *   - If DATABASE_URL is set → use that Postgres (CI, or a local one you pin).
 *   - Otherwise → spawn an ephemeral embedded Postgres (real PG 18 + pgvector),
 *     so `make test` needs no external database — same engine as `lobu run`.
 *
 * The suite is backend-agnostic: it reads DATABASE_URL and uses postgres.js, so
 * migrations, fixtures, and assertions are identical either way.
 */

import { closeDbSingleton } from '../../db/client';
import { type EmbeddedBackend, startEmbeddedBackend } from './embedded-postgres-backend';
import { closeTestDb, setupTestDatabase } from './test-db';

let embedded: EmbeddedBackend | null = null;

export async function setup(): Promise<void> {
  if (process.env.SKIP_TEST_DB_SETUP === '1') {
    console.log('\n⚠️  Skipping test database setup (SKIP_TEST_DB_SETUP=1).\n');
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
    console.log(`\n🗄️  Using Postgres at ${databaseUrl}`);
  } else {
    console.log('\n🐘 No DATABASE_URL — spawning ephemeral embedded Postgres...');
    embedded = await startEmbeddedBackend();
    process.env.DATABASE_URL = embedded.url;
    process.env.PGSSLMODE = 'disable';
    console.log(`✅ Embedded Postgres ready at ${embedded.url}`);
  }

  // Deterministic 32-byte hex key for AES-256-GCM in tests. Same value the
  // gateway's secret-store test harness uses so behavior is aligned.
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }

  console.log('🗄️  Running migrations...');
  await setupTestDatabase();
  console.log('✅ Test database ready.\n');

  // Close setup-side connections so forked test workers can connect cleanly.
  await closeTestDb();
  await closeDbSingleton();
}

export async function teardown(): Promise<void> {
  if (embedded) {
    await embedded.stop();
    embedded = null;
  }
}
