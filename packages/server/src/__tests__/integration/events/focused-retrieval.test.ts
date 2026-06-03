/**
 * Integration test: server-side focused retrieval (#1172).
 *
 * Exercises the full build → serve loop against a real Postgres:
 *
 *   1. The async builder `triggerFactExtraction` scans long events, calls the
 *      extractor, and writes one `semantic_type='extracted_fact'` event per
 *      fact, stamped with `metadata.{derived_from_event_id,
 *      fact_extractor_version}` and inheriting the parent's entity_ids +
 *      occurred_at.
 *   2. `getContent({ focused: true })` replaces the parent's text_content /
 *      payload_text with the joined facts (current extractor version only),
 *      and never lists the derived fact rows as standalone content.
 *   3. `getContent({ focused: false })` returns the raw payload and never
 *      leaks a derived fact row into the list or the count.
 *   4. The builder is idempotent at a fixed extractor version (NOT EXISTS
 *      guard), and re-extracts when the version stamp changes.
 *
 * The extractor is exercised for real — the LLM is stubbed at the network
 * boundary (`global.fetch` returns a canned chat-completion), NOT via module
 * mocking, so the test is robust under the canonical full-suite runner
 * (`vitest run` over the whole integration dir). The extractor version is
 * driven through `FACT_EXTRACTOR_MODEL` (real `factExtractorVersion`), so the
 * version-stamp + NOT EXISTS guard + version-bump branch run with real values.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, parsePgNumberArray } from '../../../db/client';
import type { Env } from '../../../index';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { factExtractorVersion } from '../../../utils/fact-extractor';
import { triggerFactExtraction } from '../../../scheduled/trigger-fact-extraction';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const FACTS = ['User lives in NYC.', 'User owns a dog named Rex.', 'User owns a cat named Whiskers.'];

// The extractor reads these off the passed `env`; setting them makes the REAL
// extractFacts run (no module mock). FACT_EXTRACTOR_MODEL feeds the version
// stamp, so mutating it drives the version-bump branch.
const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  FACT_EXTRACTOR_API_KEY: 'test-key',
  FACT_EXTRACTOR_BASE_URL: 'https://stub.invalid/v1',
  FACT_EXTRACTOR_MODEL: 'stub-model-v1',
} as Env;

// Stub the LLM at the network boundary: intercept the extractor's
// /chat/completions call, pass everything else through to the real fetch.
const originalFetch = global.fetch;
function installFetchStub() {
  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: FACTS.join('\n') } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

// A parent payload well over the 200-char extraction floor.
const PARENT_BLOB =
  'Over the course of our conversations the user shared a lot of personal detail. ' +
  'They mentioned that they live in New York City, in a walk-up apartment in the East Village. ' +
  'They talked at length about their pets: a dog named Rex who is a 4-year-old border collie, ' +
  'and a cat named Whiskers who is 7. They also described a recent trip and several purchases. ' +
  'This blob is intentionally long so it clears the focused-extraction length threshold.';

describe('focused retrieval (#1172) — build + serve loop', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let parentEventId: number;
  let parentOccurredAt: Date;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    installFetchStub();
    TEST_ENV.FACT_EXTRACTOR_MODEL = 'stub-model-v1';

    org = await createTestOrganization({ name: 'Focused Retrieval Org' });
    user = await createTestUser({ email: 'focused@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Focused Retrieval Entity',
      organization_id: org.id,
    });

    // Pin occurred_at so we can assert the derived facts inherit it.
    parentOccurredAt = new Date('2026-01-15T12:00:00.000Z');
    const parent = await createTestEvent({
      organization_id: org.id,
      entity_id: entity.id,
      content: PARENT_BLOB,
      occurred_at: parentOccurredAt,
      // 'content' semantic type — the builder must NOT treat it as a fact.
      semantic_type: 'content',
    });
    parentEventId = parent.id;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('builder extracts 3 facts as derived events with the right stamp + inherited fields', async () => {
    const result = await triggerFactExtraction(TEST_ENV);

    expect(result.events).toBe(1);
    expect(result.factsCreated).toBe(3);

    const sql = getDb();
    const factRows = (await sql`
      SELECT id, payload_text, semantic_type, entity_ids, occurred_at, organization_id, metadata
      FROM events
      WHERE semantic_type = 'extracted_fact'
        AND (metadata->>'derived_from_event_id')::bigint = ${parentEventId}
      ORDER BY id ASC
    `) as Array<{
      id: number;
      payload_text: string;
      semantic_type: string;
      // `bigint[]` reads back as a Postgres array-literal string under the prod
      // PG value options (`fetch_types: false`) — parse via parsePgNumberArray.
      entity_ids: unknown;
      occurred_at: string | null;
      organization_id: string;
      metadata: Record<string, unknown>;
    }>;

    expect(factRows).toHaveLength(3);
    expect(factRows.map((r) => r.payload_text)).toEqual(FACTS);

    const expectedVersion = factExtractorVersion(TEST_ENV);
    for (const row of factRows) {
      expect(row.semantic_type).toBe('extracted_fact');
      expect(Number(row.metadata.derived_from_event_id)).toBe(parentEventId);
      expect(row.metadata.fact_extractor_version).toBe(expectedVersion);
      expect(row.organization_id).toBe(org.id);
      // entity_ids inherited from the parent.
      const ids = parsePgNumberArray(row.entity_ids);
      expect(ids).toContain(entity.id);
      // occurred_at inherited from the parent.
      expect(new Date(row.occurred_at as string).toISOString()).toBe(parentOccurredAt.toISOString());
    }
  });

  it('focused read returns the joined facts as the parent text, with no standalone fact rows', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, focused: true } as never,
      TEST_ENV as never,
      ctx()
    );

    const expectedFacts = FACTS.join('\n');

    // The parent item carries the focused facts in BOTH fields.
    const parentItem = result.content.find((c) => c.id === parentEventId);
    expect(parentItem).toBeDefined();
    expect(parentItem!.text_content).toBe(expectedFacts);
    expect(parentItem!.payload_text).toBe(expectedFacts);
    // It is NOT the raw blob.
    expect(parentItem!.text_content).not.toContain('walk-up apartment');

    // No derived fact row appears as its own content item.
    const factRowLeaked = result.content.some((c) => c.semantic_type === 'extracted_fact');
    expect(factRowLeaked).toBe(false);

    // Exactly the parent shows up (the 3 facts are joined in, not listed).
    expect(result.content).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('non-focused read returns the raw blob and never leaks a derived fact row', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, focused: false } as never,
      TEST_ENV as never,
      ctx()
    );

    const parentItem = result.content.find((c) => c.id === parentEventId);
    expect(parentItem).toBeDefined();
    expect(parentItem!.text_content).toBe(PARENT_BLOB);
    expect(parentItem!.payload_text).toBe(PARENT_BLOB);

    // No extracted_fact rows in the list, and the count reflects that too.
    expect(result.content.some((c) => c.semantic_type === 'extracted_fact')).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('non-focused score-sorted read also excludes derived facts from list + count', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'score' } as never,
      TEST_ENV as never,
      ctx()
    );
    expect(result.content.some((c) => c.semantic_type === 'extracted_fact')).toBe(false);
    expect(result.total).toBe(result.content.length);
    expect(result.content).toHaveLength(1);
  });

  it('explicitly requesting semantic_type=extracted_fact surfaces the derived rows (escape hatch)', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, semantic_type: 'extracted_fact' } as never,
      TEST_ENV as never,
      ctx()
    );
    const factItems = result.content.filter((c) => c.semantic_type === 'extracted_fact');
    expect(factItems).toHaveLength(3);
    // And only facts come back — the parent 'content' row is filtered out.
    expect(result.content.every((c) => c.semantic_type === 'extracted_fact')).toBe(true);
  });

  it('builder is idempotent at a fixed version — second run creates 0 new facts', async () => {
    const second = await triggerFactExtraction(TEST_ENV);
    expect(second.factsCreated).toBe(0);
    expect(second.events).toBe(0);

    const sql = getDb();
    const [{ count }] = (await sql`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE semantic_type = 'extracted_fact'
        AND (metadata->>'derived_from_event_id')::bigint = ${parentEventId}
    `) as Array<{ count: number }>;
    expect(count).toBe(3);
  });

  it('version bump re-extracts under a new stamp, and focused reads serve ONLY the current version', async () => {
    const v1 = factExtractorVersion(TEST_ENV);
    // Bump the model → factExtractorVersion changes → the NOT EXISTS guard no
    // longer matches the v1 rows, so the parent is re-extracted under v2.
    TEST_ENV.FACT_EXTRACTOR_MODEL = 'stub-model-v2';
    const v2 = factExtractorVersion(TEST_ENV);
    expect(v2).not.toBe(v1);

    const third = await triggerFactExtraction(TEST_ENV);
    expect(third.factsCreated).toBe(3);
    expect(third.events).toBe(1);

    const sql = getDb();
    const versions = (await sql`
      SELECT DISTINCT metadata->>'fact_extractor_version' AS v
      FROM events
      WHERE semantic_type = 'extracted_fact'
        AND (metadata->>'derived_from_event_id')::bigint = ${parentEventId}
      ORDER BY v
    `) as Array<{ v: string }>;
    // Both versions coexist in the append-only log (6 rows total)...
    expect(versions.map((r) => r.v).sort()).toEqual([v1, v2].sort());

    // ...but the focused read serves ONLY the current (v2) version's 3 facts —
    // never a mix of stale + current. Still serves facts (not raw), lists only
    // the parent.
    const result = await getContent(
      { entity_id: entity.id, limit: 100, focused: true } as never,
      TEST_ENV as never,
      ctx()
    );
    const parentItem = result.content.find((c) => c.id === parentEventId);
    expect(parentItem).toBeDefined();
    expect(parentItem!.text_content.split('\n')).toHaveLength(3);
    expect(parentItem!.text_content).toBe(FACTS.join('\n'));
    expect(parentItem!.text_content).not.toContain('walk-up apartment');
    expect(result.content.some((c) => c.semantic_type === 'extracted_fact')).toBe(false);
    expect(result.content).toHaveLength(1);
  });
});
