/**
 * Page Auth Coverage
 *
 * Covers the class of bug where a page stays stuck on "Loading..." because a
 * backend read endpoint returns null for a resource the frontend expects to
 * exist. Exercises the core MCP tools each UI page hits under anonymous,
 * member, and owner auth states against both public and private workspaces.
 *
 * Uses scoped `/mcp/:orgSlug` sessions throughout (same pattern as
 * public-org-join.test.ts) so multiple tokens can coexist without sharing
 * the default-MCP session cache keyed by token alone.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
  type TestOAuthClient,
  type TestOrganization,
  type TestUser,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

async function initializeScopedSession(path: string, token: string): Promise<string> {
  const initResponse = await post(path, {
    body: {
      jsonrpc: '2.0',
      id: '__test_init__',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'owletto-test', version: '1.0' },
      },
    },
    token,
  });
  const sessionId = initResponse.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error(
      `MCP initialize did not return session ID (status=${initResponse.status})`
    );
  }
  await post(path, {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    headers: { 'mcp-session-id': sessionId },
    token,
  });
  return sessionId;
}

interface ToolCallArgs {
  orgSlug: string;
  sessionId: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
}

async function callTool({ orgSlug, sessionId, token, name, args }: ToolCallArgs) {
  const response = await post(`/mcp/${orgSlug}`, {
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    // X-MCP-Format: json returns raw JSON text instead of markdown-wrapped output
    headers: { 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
    token,
  });
  return response.json();
}

function parseToolResult(body: { result?: { content?: Array<{ text: string }> } }) {
  const text = body.result?.content?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

async function freshSession(
  org: TestOrganization,
  user: TestUser,
  client: TestOAuthClient,
  scope = 'mcp:read mcp:write'
) {
  const { token } = await createTestAccessToken(user.id, org.id, client.client_id, { scope });
  const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);
  return { token, sessionId };
}

describe('Page auth coverage', () => {
  let publicOrg: TestOrganization;
  let privateOrg: TestOrganization;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let client: TestOAuthClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    publicOrg = await createTestOrganization({
      name: 'Public Page Org',
      slug: 'public-page-org',
      visibility: 'public',
    });
    privateOrg = await createTestOrganization({
      name: 'Private Page Org',
      slug: 'private-page-org',
      visibility: 'private',
    });

    owner = await createTestUser({ email: 'page-owner@test.example.com' });
    member = await createTestUser({ email: 'page-member@test.example.com' });
    outsider = await createTestUser({ email: 'page-outsider@test.example.com' });

    await addUserToOrganization(owner.id, publicOrg.id, 'owner');
    await addUserToOrganization(member.id, publicOrg.id, 'member');
    await addUserToOrganization(owner.id, privateOrg.id, 'owner');

    client = await createTestOAuthClient();

    // Entity types are per-org, so seed one directly into publicOrg so the
    // list/get tests below have something to find. Matches the shape the
    // lifecycle test writes via `manage_entity_schema create`.
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, description, icon,
        metadata_schema, created_at, updated_at
      ) VALUES (
        ${publicOrg.id}, 'brand', 'Brand', 'Brand for tests', '🏢',
        ${sql.json({ type: 'object', additionalProperties: true })},
        NOW(), NOW()
      )
    `;

    await createTestEntity({
      name: 'Public Brand',
      entity_type: 'brand',
      organization_id: publicOrg.id,
      created_by: owner.id,
    });
  });

  // ------------------------------------------------------------
  // Regression: $member entity type lazily provisions on first GET.
  // Original bug: etHandleGet returned entity_type=null which left
  // /<org>/%24member stuck on "Loading..." indefinitely.
  // ------------------------------------------------------------
  describe('manage_entity_schema get $member (regression)', () => {
    it('auto-provisions the $member entity type on first access', async () => {
      const sql = getTestDb();
      const fresh = await createTestOrganization({ name: 'Fresh Members Org' });
      const freshOwner = await createTestUser({ email: 'fresh-owner@test.example.com' });
      await addUserToOrganization(freshOwner.id, fresh.id, 'owner');
      const { token, sessionId } = await freshSession(fresh, freshOwner, client);

      const before = await sql`
        SELECT id FROM entity_types
        WHERE slug = '$member' AND organization_id = ${fresh.id}
      `;
      expect(before).toHaveLength(0);

      const body = await callTool({
        orgSlug: fresh.slug,
        sessionId,
        token,
        name: 'manage_entity_schema',
        args: { schema_type: 'entity_type', action: 'get', slug: '$member' },
      });
      expect(body.result?.isError).not.toBe(true);
      const result = parseToolResult(body);
      expect(result.entity_type).not.toBeNull();
      expect(result.entity_type.slug).toBe('$member');
      expect(result.entity_type.metadata_schema).toBeDefined();
      expect(result.entity_type.event_kinds).toBeDefined();

      const after = await sql`
        SELECT id FROM entity_types
        WHERE slug = '$member' AND organization_id = ${fresh.id}
      `;
      expect(after).toHaveLength(1);

      // Second call returns the same row without throwing or re-inserting.
      const body2 = await callTool({
        orgSlug: fresh.slug,
        sessionId,
        token,
        name: 'manage_entity_schema',
        args: { schema_type: 'entity_type', action: 'get', slug: '$member' },
      });
      const result2 = parseToolResult(body2);
      expect(result2.entity_type?.slug).toBe('$member');

      const afterSecond = await sql`
        SELECT id FROM entity_types
        WHERE slug = '$member' AND organization_id = ${fresh.id}
      `;
      expect(afterSecond).toHaveLength(1);
    });

    it('still returns null for unknown non-reserved slugs', async () => {
      const { token, sessionId } = await freshSession(publicOrg, owner, client);
      const body = await callTool({
        orgSlug: publicOrg.slug,
        sessionId,
        token,
        name: 'manage_entity_schema',
        args: { schema_type: 'entity_type', action: 'get', slug: 'does-not-exist-xyz' },
      });
      const result = parseToolResult(body);
      expect(result.entity_type).toBeNull();
    });
  });

  // ------------------------------------------------------------
  // resolve_path — the single call OwnerResolver makes for every
  // workspace page. If this fails the entire app stays on "Loading...".
  // ------------------------------------------------------------
  describe('resolve_path', () => {
    for (const [label, getUser] of [
      ['owner', () => owner],
      ['member', () => member],
    ] as const) {
      it(`resolves the workspace home as ${label}`, async () => {
        const { token, sessionId } = await freshSession(publicOrg, getUser(), client);
        const body = await callTool({
          orgSlug: publicOrg.slug,
          sessionId,
          token,
          name: 'resolve_path',
          args: { path: `/${publicOrg.slug}` },
        });
        expect(body.result?.isError).not.toBe(true);
        const result = parseToolResult(body);
        expect(result.workspace?.slug).toBe(publicOrg.slug);
      });

      it(`resolves an entity detail path as ${label}`, async () => {
        const { token, sessionId } = await freshSession(publicOrg, getUser(), client);
        const body = await callTool({
          orgSlug: publicOrg.slug,
          sessionId,
          token,
          name: 'resolve_path',
          args: { path: `/${publicOrg.slug}/brand/public-brand` },
        });
        expect(body.result?.isError).not.toBe(true);
        const result = parseToolResult(body);
        expect(result.entity?.name).toBe('Public Brand');
      });
    }
  });

  // ------------------------------------------------------------
  // manage_entity_schema list/get — sidebar, entity-type list,
  // member detail page. list must not return an empty array when
  // the org has system types.
  // ------------------------------------------------------------
  describe('manage_entity_schema list/get', () => {
    for (const [label, getUser] of [
      ['owner', () => owner],
      ['member', () => member],
    ] as const) {
      it(`returns system types as ${label}`, async () => {
        const { token, sessionId } = await freshSession(publicOrg, getUser(), client);
        const body = await callTool({
          orgSlug: publicOrg.slug,
          sessionId,
          token,
          name: 'manage_entity_schema',
          args: { schema_type: 'entity_type', action: 'list' },
        });
        expect(body.result?.isError).not.toBe(true);
        const result = parseToolResult(body);
        expect(Array.isArray(result.entity_types)).toBe(true);
        expect(result.entity_types.length).toBeGreaterThan(0);
        expect(result.entity_types.some((t: { slug: string }) => t.slug === 'brand')).toBe(true);
      });

      it(`returns a concrete entity_type for 'brand' as ${label}`, async () => {
        const { token, sessionId } = await freshSession(publicOrg, getUser(), client);
        const body = await callTool({
          orgSlug: publicOrg.slug,
          sessionId,
          token,
          name: 'manage_entity_schema',
          args: { schema_type: 'entity_type', action: 'get', slug: 'brand' },
        });
        expect(body.result?.isError).not.toBe(true);
        const result = parseToolResult(body);
        expect(result.entity_type).not.toBeNull();
        expect(result.entity_type.slug).toBe('brand');
      });
    }
  });

  // ------------------------------------------------------------
  // manage_entity list — entity list pages must not silently return
  // an empty payload when the org has entities.
  // ------------------------------------------------------------
  describe('manage_entity list', () => {
    for (const [label, getUser] of [
      ['owner', () => owner],
      ['member', () => member],
    ] as const) {
      it(`lists brand entities as ${label}`, async () => {
        const { token, sessionId } = await freshSession(publicOrg, getUser(), client);
        const body = await callTool({
          orgSlug: publicOrg.slug,
          sessionId,
          token,
          name: 'manage_entity',
          args: { action: 'list', entity_type: 'brand' },
        });
        expect(body.result?.isError).not.toBe(true);
        const result = parseToolResult(body);
        expect(Array.isArray(result.entities)).toBe(true);
        expect(result.entities.length).toBeGreaterThan(0);
      });
    }
  });

  // ------------------------------------------------------------
  // Anonymous reads — unauthenticated users landing on a public
  // org should render the public home without a sign-in redirect.
  // ------------------------------------------------------------
  describe('anonymous access', () => {
    it('public/organization returns 200 for public org', async () => {
      const response = await get(`/api/${publicOrg.slug}/public/organization`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.organization?.slug).toBe(publicOrg.slug);
    });

    it('public/organization returns 404 for private org (no existence leak)', async () => {
      const response = await get(`/api/${privateOrg.slug}/public/organization`);
      expect(response.status).toBe(404);
    });

    it('public/agents returns 200 for public org', async () => {
      const response = await get(`/api/${publicOrg.slug}/public/agents`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.agents)).toBe(true);
    });
  });

  // ------------------------------------------------------------
  // Scoped MCP read on a public org as a non-member — mirrors what
  // the members page does before the user joins: the workspace
  // has to be browsable and read-only tool calls should succeed.
  // ------------------------------------------------------------
  describe('non-member scoped read on public org', () => {
    it('permits resolve_path as a non-member via /mcp/:orgSlug', async () => {
      const { token, sessionId } = await freshSession(
        publicOrg,
        outsider,
        client,
        'mcp:read profile:read'
      );
      const body = await callTool({
        orgSlug: publicOrg.slug,
        sessionId,
        token,
        name: 'resolve_path',
        args: { path: `/${publicOrg.slug}` },
      });
      expect(body.result?.isError).not.toBe(true);
      const result = parseToolResult(body);
      expect(result.workspace?.slug).toBe(publicOrg.slug);
    });

    it('rejects MCP initialize against a private org', async () => {
      const { token } = await createTestAccessToken(outsider.id, privateOrg.id, client.client_id, {
        scope: 'mcp:read profile:read',
      });
      const response = await post(`/mcp/${privateOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'owletto-test', version: '1.0' },
          },
        },
        token,
      });
      expect([401, 403, 404]).toContain(response.status);
    });
  });

  // ------------------------------------------------------------
  // Owner token against private org continues to work — regression
  // sanity check that private-org tooling didn't get broken by any
  // public-org plumbing.
  // ------------------------------------------------------------
  describe('private org owner retains full access', () => {
    it('resolves the private org home for its owner', async () => {
      const { token, sessionId } = await freshSession(privateOrg, owner, client);
      const body = await callTool({
        orgSlug: privateOrg.slug,
        sessionId,
        token,
        name: 'resolve_path',
        args: { path: `/${privateOrg.slug}` },
      });
      expect(body.result?.isError).not.toBe(true);
      const result = parseToolResult(body);
      expect(result.workspace?.slug).toBe(privateOrg.slug);
    });
  });
});
