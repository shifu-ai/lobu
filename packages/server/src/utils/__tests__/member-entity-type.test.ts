import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { createTestOrganization } from '../../__tests__/setup/test-fixtures';
import {
  clearEventKindsCacheForTests,
  validateSaveContentSemanticType,
} from '../event-kind-validation';
import { ensureMemberEntityType, mergeMemberEventKinds } from '../member-entity-type';

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDb('ensureMemberEntityType event kinds', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEventKindsCacheForTests();
  });

  it('seeds project_profile and course_pm_profile for new member entity types', async () => {
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
    expect(rows[0].event_kinds).toHaveProperty('course_pm_profile');
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
    expect(eventKinds).toHaveProperty('course_pm_profile');
    expect(eventKinds).toHaveProperty('custom_kind');
    expect(eventKinds.note).toEqual({ description: 'Custom note definition' });
  });

  it('accepts course_pm_profile save content metadata and still rejects unknown kinds', async () => {
    const org = await createTestOrganization({ name: 'Course PM Profile Validation Org' });
    await ensureMemberEntityType(org.id);

    const validResult = await validateSaveContentSemanticType(
      'course_pm_profile',
      {
        memoryKind: 'course_pm_profile',
        source: 'toolbox_onboarding',
        toolboxUserId: 'user-1',
        agentId: 'shifu-u-1',
        profileId: 'course_pm_profile_1',
        profileVersion: 1,
        courseCount: 1,
      },
      org.id
    );
    expect(validResult.valid).toBe(true);

    const invalidResult = await validateSaveContentSemanticType(
      'unknown_course_pm_profile',
      {},
      org.id
    );
    expect(invalidResult.valid).toBe(false);
  });
});

describe('mergeMemberEventKinds', () => {
  it('includes course_pm_profile in default event kinds', () => {
    const merged = mergeMemberEventKinds(null);

    expect(merged).toHaveProperty('course_pm_profile');
  });

  it('does not overwrite custom project_profile or course_pm_profile definitions', () => {
    const customProjectProfile = {
      description: 'Custom project profile',
      metadataSchema: {
        type: 'object',
        properties: {
          custom: { type: 'string' },
        },
      },
    };
    const customCoursePmProfile = {
      description: 'Custom course PM profile',
      metadataSchema: {
        type: 'object',
        properties: {
          customCoursePmField: { type: 'string' },
        },
      },
    };

    const merged = mergeMemberEventKinds({
      project_profile: customProjectProfile,
      course_pm_profile: customCoursePmProfile,
    });

    expect(merged.project_profile).toEqual(customProjectProfile);
    expect(merged.course_pm_profile).toEqual(customCoursePmProfile);
  });
});
