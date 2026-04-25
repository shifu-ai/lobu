/**
 * Integration tests for the per-field watcher feedback API.
 *
 * Covers the schema introduced by the
 * `20260425100000_normalize_watcher_feedback` migration:
 * - `submit_feedback` accepts an array of {field_path, mutation, value, note}
 * - mutation kinds: `set` (default), `remove`, `add`
 * - `get_feedback` returns one row per submission, newest first; the prompt
 *   summary is responsible for collapsing per-field at read time
 * - validation: empty array, bad mutation, missing value for set/add
 *
 * The watcher row is built directly via SQL because the existing
 * `createTestWatcherTemplate` fixture predates the `watcher_group_id NOT NULL`
 * migration and would fail unrelated to anything tested here.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpToolsCall } from '../../setup/test-helpers';

interface SeededWatcher {
  id: number;
  versionId: number;
}

async function seedWatcher(organizationId: string, userId: string): Promise<SeededWatcher> {
  const sql = getTestDb();
  const [version] = await sql<{ id: number }[]>`
    INSERT INTO watcher_versions (
      version, name, description, prompt, extraction_schema, created_by
    ) VALUES (
      1,
      'Feedback Test',
      'Watcher used to exercise the feedback APIs',
      'Analyze inputs',
      ${sql.json({
        type: 'object',
        properties: {
          problems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              },
            },
          },
        },
      })},
      ${userId}
    )
    RETURNING id
  `;

  const [watcher] = await sql<{ id: number }[]>`
    INSERT INTO watchers (
      slug, name, description, status, created_by, organization_id,
      current_version_id, watcher_group_id
    ) VALUES (
      'feedback-test',
      'Feedback Test',
      'Feedback API integration watcher',
      'active',
      ${userId},
      ${organizationId},
      ${version.id},
      0
    )
    RETURNING id
  `;
  await sql`UPDATE watchers SET watcher_group_id = ${watcher.id} WHERE id = ${watcher.id}`;
  await sql`UPDATE watcher_versions SET watcher_id = ${watcher.id} WHERE id = ${version.id}`;

  return { id: watcher.id, versionId: version.id };
}

async function seedWindow(
  watcherId: number,
  extractedData: Record<string, unknown>
): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO watcher_windows (
      watcher_id, granularity, window_start, window_end,
      extracted_data, content_analyzed, model_used, created_at
    ) VALUES (
      ${watcherId}, 'weekly',
      ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)},
      ${new Date()},
      ${sql.json(extractedData)},
      0, 'test-model', NOW()
    )
    RETURNING id
  `;
  return row.id;
}

describe('Watcher feedback', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let watcher: SeededWatcher;
  let windowId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Feedback Test Org' });
    user = await createTestUser({ email: 'feedback@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    // createTestEntity ensures the org-bound entity types are seeded; the
    // entity itself isn't referenced by the feedback flow.
    await createTestEntity({ name: 'Feedback Entity', organization_id: org.id });

    watcher = await seedWatcher(org.id, user.id);
    windowId = await seedWindow(watcher.id, {
      problems: [
        { name: 'A', severity: 'low' },
        { name: 'B', severity: 'medium' },
      ],
    });
  });

  beforeEach(async () => {
    const sql = getTestDb();
    await sql`DELETE FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id}`;
  });

  describe('submit_feedback', () => {
    it('accepts a single set correction (default mutation)', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [
            { field_path: 'problems[0].severity', value: 'high', note: 'misclassified' },
          ],
        },
        { token }
      );
      expect(result.feedback_ids).toHaveLength(1);

      const sql = getTestDb();
      const rows = await sql<
        {
          field_path: string;
          mutation: string;
          corrected_value: unknown;
          note: string | null;
        }[]
      >`SELECT field_path, mutation, corrected_value, note FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0].field_path).toBe('problems[0].severity');
      expect(rows[0].mutation).toBe('set');
      expect(rows[0].corrected_value).toBe('high');
      expect(rows[0].note).toBe('misclassified');
    });

    it('accepts a remove correction without a value', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: 'problems[1]', mutation: 'remove' }],
        },
        { token }
      );
      expect(result.feedback_ids).toHaveLength(1);

      const sql = getTestDb();
      const rows = await sql<
        { mutation: string; corrected_value: unknown }[]
      >`SELECT mutation, corrected_value FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id}`;
      expect(rows[0].mutation).toBe('remove');
      expect(rows[0].corrected_value).toBeNull();
    });

    it('accepts an add correction that appends to an array', async () => {
      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [
            {
              field_path: 'problems',
              mutation: 'add',
              value: { name: 'C', severity: 'high' },
            },
          ],
        },
        { token }
      );
      expect(result.feedback_ids).toHaveLength(1);

      const sql = getTestDb();
      const rows = await sql<
        { mutation: string; corrected_value: { name: string; severity: string } }[]
      >`SELECT mutation, corrected_value FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id}`;
      expect(rows[0].mutation).toBe('add');
      expect(rows[0].corrected_value).toEqual({ name: 'C', severity: 'high' });
    });

    it('stores multiple corrections from one batch as separate rows', async () => {
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [
            { field_path: 'problems[0].severity', value: 'high' },
            { field_path: 'problems[0].name', value: 'Renamed A' },
            { field_path: 'problems[1]', mutation: 'remove' },
          ],
        },
        { token }
      );

      const sql = getTestDb();
      const rows = await sql`SELECT field_path, mutation FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id} ORDER BY field_path`;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.field_path)).toEqual([
        'problems[0].name',
        'problems[0].severity',
        'problems[1]',
      ]);
    });

    it('lets a later submission supersede an earlier one without overwriting', async () => {
      const path = 'problems[0].severity';
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: path, value: 'medium' }],
        },
        { token }
      );
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: path, value: 'high', note: 'on second look' }],
        },
        { token }
      );

      const sql = getTestDb();
      const rows = await sql<
        { corrected_value: unknown; note: string | null }[]
      >`SELECT corrected_value, note FROM watcher_window_field_feedback WHERE watcher_id = ${watcher.id} AND field_path = ${path} ORDER BY created_at ASC, id ASC`;
      expect(rows).toHaveLength(2);
      expect(rows[0].corrected_value).toBe('medium');
      expect(rows[1].corrected_value).toBe('high');
      expect(rows[1].note).toBe('on second look');
    });

    it('rejects an empty corrections array', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'submit_feedback',
            watcher_id: String(watcher.id),
            window_id: windowId,
            corrections: [],
          },
          { token }
        )
      ).rejects.toThrow(/non-empty array/);
    });

    it('rejects an unsupported mutation kind', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'submit_feedback',
            watcher_id: String(watcher.id),
            window_id: windowId,
            corrections: [{ field_path: 'problems[0]', mutation: 'patch', value: 'x' }],
          },
          { token }
        )
      ).rejects.toThrow();
    });

    it('rejects a set mutation with no value', async () => {
      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'submit_feedback',
            watcher_id: String(watcher.id),
            window_id: windowId,
            corrections: [{ field_path: 'problems[0].severity' }],
          },
          { token }
        )
      ).rejects.toThrow(/requires a value/);
    });

    it('refuses to submit feedback against a watcher in a different org', async () => {
      // Build a watcher in a second org. The first user (Alice) has no
      // membership there, so her token's org context is still the first org;
      // passing the foreign watcher_id must fail the org-scoped windowCheck.
      const otherOrg = await createTestOrganization({ name: 'Stranger Org' });
      const otherUser = await createTestUser({ email: 'stranger@test.com' });
      await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
      const foreign = await seedWatcher(otherOrg.id, otherUser.id);
      const foreignWindow = await seedWindow(foreign.id, { problems: [] });

      await expect(
        mcpToolsCall(
          'manage_watchers',
          {
            action: 'submit_feedback',
            watcher_id: String(foreign.id),
            window_id: foreignWindow,
            corrections: [{ field_path: 'problems[0]', value: 'x' }],
          },
          { token }
        )
      ).rejects.toThrow(/not found/);
    });
  });

  describe('get_feedback', () => {
    it('returns rows newest-first for a watcher', async () => {
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: 'problems[0].severity', value: 'medium' }],
        },
        { token }
      );
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
        },
        { token }
      );

      const result = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'get_feedback',
          watcher_id: String(watcher.id),
        },
        { token }
      );
      expect(result.feedback).toHaveLength(2);
      expect(result.feedback[0].corrected_value).toBe('high');
      expect(result.feedback[1].corrected_value).toBe('medium');
    });

    it('filters by window_id when provided', async () => {
      const otherWindow = await seedWindow(watcher.id, { problems: [] });
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: windowId,
          corrections: [{ field_path: 'a', value: 1 }],
        },
        { token }
      );
      await mcpToolsCall(
        'manage_watchers',
        {
          action: 'submit_feedback',
          watcher_id: String(watcher.id),
          window_id: otherWindow,
          corrections: [{ field_path: 'b', value: 2 }],
        },
        { token }
      );

      const filtered = await mcpToolsCall(
        'manage_watchers',
        {
          action: 'get_feedback',
          watcher_id: String(watcher.id),
          window_id: otherWindow,
        },
        { token }
      );
      expect(filtered.feedback).toHaveLength(1);
      expect(filtered.feedback[0].field_path).toBe('b');
    });
  });
});
