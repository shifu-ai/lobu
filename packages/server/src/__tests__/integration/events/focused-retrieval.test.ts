/**
 * Integration test: server-side focused retrieval (#1172).
 *
 * Exercises the full build → serve loop against a real Postgres:
 *
 *   1. The async builder `triggerFactExtraction` scans long events, calls the
 *      (stubbed) extractor, and writes one `semantic_type='extracted_fact'`
 *      event per fact, stamped with `metadata.{derived_from_event_id,
 *      fact_extractor_version}` and inheriting the parent's entity_ids +
 *      occurred_at.
 *   2. `getContent({ focused: true })` replaces the parent's text_content /
 *      payload_text with the joined facts, and never lists the derived
 *      fact rows as standalone content.
 *   3. `getContent({ focused: false })` returns the raw payload and never
 *      leaks a derived fact row into the list or the count.
 *   4. The builder is idempotent at a fixed extractor version (NOT EXISTS
 *      guard), and re-extracts when the version stamp changes.
 *
 * The LLM is stubbed via `vi.mock` so the test is deterministic and offline.
 * `factExtractorVersion` is also stubbed (to a controllable string) so the
 * version-stamp + NOT EXISTS guard are exercised with a known value and the
 * version-bump branch can be driven.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, parsePgNumberArray } from '../../../db/client';
import type { Env } from '../../../index';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
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

// ── Stub the extractor LLM ────────────────────────────────────────────────
// `vi.hoisted` lets the mock factory close over mutable state the test mutates
// (the fact list + the version stamp) so we can drive idempotency and the
// version-bump branch without re-mocking.
const stub = vi.hoisted(() => ({
  facts: ['User lives in NYC.', 'User owns a dog named Rex.', 'User owns a cat named Whiskers.'],
  version: 'fact-extract-test:v1',
}));

vi.mock('../../../utils/fact-extractor', () => ({
  extractFacts: vi.fn(async () => stub.facts),
  factExtractorVersion: vi.fn(() => stub.version),
  factExtractorModel: vi.fn(() => 'stub-model'),
}));

// Import AFTER the mock so the builder picks up the stubbed extractor.
import { triggerFactExtraction } from '../../../scheduled/trigger-fact-extraction';

const TEST_ENV = { ENVIRONMENT: 'test', DATABASE_URL: process.env.DATABASE_URL } as Env;

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

    // Reset the stub to its default state for each fresh suite run.
    stub.facts = ['User lives in NYC.', 'User owns a dog named Rex.', 'User owns a cat named Whiskers.'];
    stub.version = 'fact-extract-test:v1';
  });

  afterAll(() => {
    vi.restoreAllMocks();
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
    expect(factRows.map((r) => r.payload_text)).toEqual([
      'User lives in NYC.',
      'User owns a dog named Rex.',
      'User owns a cat named Whiskers.',
    ]);

    for (const row of factRows) {
      expect(row.semantic_type).toBe('extracted_fact');
      expect(Number(row.metadata.derived_from_event_id)).toBe(parentEventId);
      expect(row.metadata.fact_extractor_version).toBe('fact-extract-test:v1');
      expect(row.organization_id).toBe(org.id);
      // entity_ids inherited from the parent.
      const ids = parsePgNumberArray(row.entity_ids);
      expect(ids).toContain(entity.id);
      // occurred_at inherited from the parent.
      expect(new Date(row.occurred_at as string).toISOString()).toBe(
        parentOccurredAt.toISOString()
      );
    }
  });

  it('focused read returns the joined facts as the parent text, with no standalone fact rows', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, focused: true } as never,
      TEST_ENV as never,
      ctx()
    );

    const expectedFacts = [
      'User lives in NYC.',
      'User owns a dog named Rex.',
      'User owns a cat named Whiskers.',
    ].join('\n');

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

  it('version bump re-extracts: new stamp produces a fresh set of fact rows', async () => {
    // Bump the stubbed extractor version → the NOT EXISTS guard no longer
    // matches the v1 rows, so the parent is re-extracted under v2.
    stub.version = 'fact-extract-test:v2';

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
    expect(versions.map((r) => r.v)).toEqual(['fact-extract-test:v1', 'fact-extract-test:v2']);

    // Focused read now aggregates BOTH versions' facts (6 lines). It still
    // serves facts (not the raw blob) and still lists only the parent.
    const result = await getContent(
      { entity_id: entity.id, limit: 100, focused: true } as never,
      TEST_ENV as never,
      ctx()
    );
    const parentItem = result.content.find((c) => c.id === parentEventId);
    expect(parentItem).toBeDefined();
    expect(parentItem!.text_content.split('\n')).toHaveLength(6);
    expect(parentItem!.text_content).not.toContain('walk-up apartment');
    expect(result.content.some((c) => c.semantic_type === 'extracted_fact')).toBe(false);
    expect(result.content).toHaveLength(1);
  });
});
