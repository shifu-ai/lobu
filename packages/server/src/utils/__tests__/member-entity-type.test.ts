import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { createTestOrganization } from '../../__tests__/setup/test-fixtures';
import { clearEventKindsCacheForTests } from '../event-kind-validation';
import { ensureMemberEntityType, mergeMemberEventKinds } from '../member-entity-type';

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDb('ensureMemberEntityType event kinds', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEventKindsCacheForTests();
  });

  it('seeds project_profile for new member entity types', async () => {
    const org = await createTestOrganization({ name: 'Project Profile Defaults Org' });
    await ensureMemberEntityType(org.id);

    const sql = getTestDb();
    const rows = await sql`
      SELECT event_kinds
      FROM entity_types
      WHERE organization_id = ${org.id}
        AND slug = '$member'
        AND deleted_at IS NULL
      LIMIT 1
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].event_kinds).toHaveProperty('project_profile');
  });

  it('merges missing built-in kinds without dropping custom kinds', async () => {
    const org = await createTestOrganization({ name: 'Project Profile Merge Org' });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_types (
        slug, name, organization_id, metadata_schema, event_kinds, created_at, updated_at
      )
      VALUES (
        '$member',
        'Member',
        ${org.id},
        '{}'::jsonb,
        ${sql.json({
          custom_kind: { description: 'Custom org event kind' },
          note: { description: 'Custom note definition' },
        })},
        NOW(),
        NOW()
      )
    `;

    await ensureMemberEntityType(org.id);

    const rows = await sql`
      SELECT event_kinds
      FROM entity_types
      WHERE organization_id = ${org.id}
        AND slug = '$member'
        AND deleted_at IS NULL
      LIMIT 1
    `;
    const eventKinds = rows[0].event_kinds as Record<string, unknown>;
    expect(eventKinds).toHaveProperty('project_profile');
    expect(eventKinds).toHaveProperty('custom_kind');
    expect(eventKinds.note).toEqual({ description: 'Custom note definition' });
  });
});

describe('mergeMemberEventKinds', () => {
  it('does not overwrite a custom project_profile definition', () => {
    const customProjectProfile = {
      description: 'Custom project profile',
      metadataSchema: {
        type: 'object',
        properties: {
          custom: { type: 'string' },
        },
      },
    };

    const merged = mergeMemberEventKinds({
      project_profile: customProjectProfile,
    });

    expect(merged.project_profile).toEqual(customProjectProfile);
  });
});
