/**
 * Regression for the active-claim INSERT into agent_release_capability_snapshots.
 *
 * postgres.js with the prod value options double-encodes
 * `${JSON.stringify(ids)}::jsonb` into a jsonb *string*, which violates
 * agent_release_capability_ids_array_check — so every production turn threw on
 * the write and collapsed to enrolled_inactive (2026-07-19). The pglite test
 * adapter sends params as text and cannot reproduce this, so this test runs
 * against the real client (getTestDb shares PROD_PG_VALUE_OPTIONS).
 */

import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../db/client';
import {
  cleanupTestDatabase,
  getTestDb,
} from '../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from '../../__tests__/setup/test-fixtures';
import { readAgentReleaseCapabilityState } from '../agent-release-service';

describe('readAgentReleaseCapabilityState — active claim snapshot write', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Release Snapshot Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('persists the claim with capability_ids as a jsonb array', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const [agentRow] = await sql<{
      owner_user_id: string;
      identity_md: string | null;
      soul_md: string | null;
      user_md: string | null;
      model_selection: Record<string, unknown> | null;
      tools_config: Record<string, unknown> | null;
    }>`
      SELECT owner_user_id, identity_md, soul_md, user_md, model_selection, tools_config
      FROM agents WHERE organization_id = ${orgId} AND id = ${agentId}
    `;
    const settingsHash = `sha256:${createHash('sha256')
      .update(
        canonicalize({
          identityMd: agentRow.identity_md ?? '',
          soulMd: agentRow.soul_md ?? '',
          userMd: agentRow.user_md ?? '',
          modelSelection: agentRow.model_selection ?? {},
          toolsConfig: agentRow.tools_config ?? {},
        }),
      )
      .digest('hex')}`;
    await sql`
      INSERT INTO agent_release_applies (
        organization_id, agent_id, environment,
        desired_release_id, desired_release_sequence, desired_feed_sequence,
        applied_release_id, applied_release_sequence, applied_feed_sequence,
        applied_channel, applied_feed_digest, manifest_digest,
        status, revision_ref, settings_hash
      ) VALUES (
        ${orgId}, ${agentId}, 'production',
        'release-9', 9, 4,
        'release-9', 9, 4,
        'candidate', ${`sha256:${'b'.repeat(64)}`}, ${`sha256:${'c'.repeat(64)}`},
        'applied', 'rev-1', ${settingsHash}
      )
    `;

    const capabilities = [
      'personal_reminder_delivery.v1',
      'sales_battle_report.scheduler.v2',
    ];
    const state = await readAgentReleaseCapabilityState({
      organizationId: orgId,
      agentId,
      environment: 'production',
      snapshot: {
        schemaVersion: 1,
        environment: 'production',
        toolboxUserId: agentRow.owner_user_id,
        agentId,
        capabilities,
        appliedReleaseId: 'release-9',
        appliedReleaseSequence: 9,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
      },
      sql,
    });
    expect(state.status).toBe('active');

    const rows = await sql<{
      kind: string;
      capability_ids: unknown;
    }>`
      SELECT jsonb_typeof(capability_ids) AS kind, capability_ids
      FROM agent_release_capability_snapshots
      WHERE organization_id = ${orgId} AND agent_id = ${agentId} AND release_sequence = 9
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('array');
    expect(rows[0].capability_ids).toEqual(capabilities);
  });
});
