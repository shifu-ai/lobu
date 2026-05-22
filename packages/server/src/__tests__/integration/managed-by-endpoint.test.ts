/**
 * `PATCH /api/:orgSlug/organization/managed-by` — HTTP auth gates.
 *
 * The endpoint flips an org between UI- and code-managed (code-managed orgs
 * are prunable by `lobu apply`). It is a destructive capability, so it gates:
 *   - org context required;
 *   - the caller must be owner/admin (members → 403);
 *   - PAT auth is rejected (use OAuth / web session);
 *   - OAuth callers must hold the `mcp:admin` scope;
 *   - body `managed_by` must be exactly "ui" | "code" (else 400).
 *
 * These mirror the sibling `/organization/visibility` gates; this suite hits
 * the real Hono route via `app.fetch` (the `patch` test-helper) with real
 * OAuth tokens so the mcpAuth → memberRole/authSource/scope derivation is
 * exercised end to end, not stubbed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../setup/test-fixtures';
import { patch } from '../setup/test-helpers';

describe('PATCH /api/:orgSlug/organization/managed-by (auth gates)', () => {
  let orgSlug: string;
  let orgId: string;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let ownerId: string;
  let memberId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Managed-By Endpoint Org' });
    orgId = org.id;
    orgSlug = org.slug;

    const owner = await createTestUser({ email: 'mb-owner@test.com' });
    ownerId = owner.id;
    await addUserToOrganization(ownerId, orgId, 'owner');

    const member = await createTestUser({ email: 'mb-member@test.com' });
    memberId = member.id;
    await addUserToOrganization(memberId, orgId, 'member');

    client = await createTestOAuthClient({ client_name: 'Managed-By Endpoint Client' });
  });

  it('owner with mcp:admin flips managed_by to code, then back to ui', async () => {
    const { token } = await createTestAccessToken(ownerId, orgId, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    const res = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'code' },
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organization.managed_by).toBe('code');

    // Persisted to the DB, not just echoed.
    const sql = getTestDb();
    const [row] = await sql<{ managed_by: string }[]>`
      SELECT managed_by FROM "organization" WHERE id = ${orgId}
    `;
    expect(row?.managed_by).toBe('code');

    // Idempotent flip back.
    const back = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'ui' },
      token,
    });
    expect(back.status).toBe(200);
    expect((await back.json()).organization.managed_by).toBe('ui');
  });

  it('rejects a non-admin member with 403', async () => {
    const { token } = await createTestAccessToken(memberId, orgId, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    const res = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'code' },
      token,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('forbidden');

    // The member's denied request did not mutate provenance.
    const sql = getTestDb();
    const [row] = await sql<{ managed_by: string }[]>`
      SELECT managed_by FROM "organization" WHERE id = ${orgId}
    `;
    expect(row?.managed_by).toBe('ui');
  });

  it('rejects an OAuth owner that lacks mcp:admin with 403', async () => {
    const { token } = await createTestAccessToken(ownerId, orgId, client.client_id, {
      scope: 'mcp:read mcp:write',
    });

    const res = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'code' },
      token,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('rejects a personal access token (PAT) with 403', async () => {
    // PATs authenticate the owner but `authSource === 'pat'` is gated out
    // regardless of scope — code-management changes need OAuth / web session.
    const { token } = await createTestPAT(ownerId, orgId);

    const res = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'code' },
      token,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('rejects an invalid managed_by value with 400', async () => {
    const { token } = await createTestAccessToken(ownerId, orgId, client.client_id, {
      scope: 'mcp:read mcp:write mcp:admin',
    });

    const res = await patch(`/api/${orgSlug}/organization/managed-by`, {
      body: { managed_by: 'frozen' },
      token,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');

    // Rejected value never reached the DB.
    const sql = getTestDb();
    const [row] = await sql<{ managed_by: string }[]>`
      SELECT managed_by FROM "organization" WHERE id = ${orgId}
    `;
    expect(row?.managed_by).toBe('ui');
  });
});
