import { beforeAll, describe, expect, it } from 'vitest';
import { installAgentFromTemplate, resyncInstalledAgent } from '../../../agents/install';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('installAgentFromTemplate', () => {
  let templateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let templateAgent: Awaited<ReturnType<typeof createTestAgent>>;
  let userOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    templateOrg = await createTestOrganization({
      name: 'Personal Finance Template',
      slug: 'personal-finance-tpl',
      visibility: 'public',
    });
    templateAgent = await createTestAgent({
      organizationId: templateOrg.id,
      name: 'Personal Finance',
    });

    user = await createTestUser();
    userOrg = await createTestOrganization({ name: 'User Personal Org' });
    await addUserToOrganization(user.id, userOrg.id, 'owner');

    // Seed two entity types and one relationship type in the template org.
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id, created_by)
      VALUES
        ('tax_year', 'Tax Year', 'Fiscal year', '{"type":"object"}'::jsonb, ${templateOrg.id}, ${user.id}),
        ('transaction', 'Transaction', 'A debit/credit', '{"type":"object"}'::jsonb, ${templateOrg.id}, ${user.id})
    `;
    await sql`
      INSERT INTO entity_relationship_types (slug, name, description, metadata_schema, organization_id, created_by, status)
      VALUES
        ('for_tax_year', 'For Tax Year', NULL, '{"type":"object"}'::jsonb, ${templateOrg.id}, ${user.id}, 'active')
    `;
    const watcherRows = await sql`
      INSERT INTO watchers (
        organization_id, slug, name, description, status, created_by,
        model_config, sources, schedule, agent_id
      ) VALUES (
        ${templateOrg.id}, 'gmail-tx', 'Gmail extractor', 'Extract finance events', 'active', ${user.id},
        '{"model":"test"}'::jsonb,
        '[{"name":"gmail_messages","query":"SELECT id FROM events"}]'::jsonb,
        '*/30 * * * *', ${templateAgent.agentId}
      )
      RETURNING id
    `;
    const watcherId = watcherRows[0].id as number;
    const watcherVersionRows = await sql`
      INSERT INTO watcher_versions (
        watcher_id, version, name, description, created_by, prompt,
        extraction_schema, required_source_types, recommended_source_types,
        reactions_guidance
      ) VALUES (
        ${watcherId}, 1, 'Gmail extractor v1', 'Current template', ${user.id}, 'Extract {{sources.gmail_messages}}',
        '{"type":"object","properties":{"transactions":{"type":"array"}}}'::jsonb,
        '{google.gmail}'::text[], '{document}'::text[], 'Create transaction entities'
      )
      RETURNING id
    `;
    await sql`
      UPDATE watchers
      SET current_version_id = ${watcherVersionRows[0].id as number}
      WHERE id = ${watcherId}
    `;
    const classifierRows = await sql`
      INSERT INTO event_classifiers (
        organization_id, slug, name, description, attribute_key, status,
        created_by, watcher_id
      ) VALUES (
        ${templateOrg.id}, 'tax-relevance', 'Tax relevance', 'Classify tax relevance', 'tax_relevance',
        'active', ${user.id}, ${watcherId}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO event_classifier_versions (
        classifier_id, version, is_current, attribute_values, min_similarity,
        fallback_value, change_notes, created_by, preferred_model, extraction_config
      ) VALUES (
        ${classifierRows[0].id as number}, 1, true,
        '[{"value":"income","description":"Taxable income"}]'::jsonb,
        0.75, 'none', 'Initial template', ${user.id}, '@cf/meta/llama-3.1-8b-instruct',
        '{"mode":"llm"}'::jsonb
      )
    `;
  });

  it('creates a new agent row in the target org with template_agent_id set', async () => {
    const result = await installAgentFromTemplate({
      templateAgentId: templateAgent.agentId,
      targetOrganizationId: userOrg.id,
      userId: user.id,
    });

    expect(result.created).toBe(true);
    expect(result.mirrored.entity_types).toBe(2);
    expect(result.mirrored.entity_relationship_types).toBe(1);
    expect(result.mirrored.watchers).toBe(1);
    expect(result.mirrored.event_classifiers).toBe(1);

    const sql = getTestDb();
    const rows = await sql`
      SELECT id, template_agent_id, organization_id, owner_user_id
      FROM agents
      WHERE id = ${result.agentId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].template_agent_id).toBe(templateAgent.agentId);
    expect(rows[0].organization_id).toBe(userOrg.id);
    expect(rows[0].owner_user_id).toBe(user.id);
  });

  it('mirrors entity types with managed_by_template_agent_id set', async () => {
    const sql = getTestDb();
    const rows = await sql`
      SELECT slug, managed_by_template_agent_id, source_template_org_id
      FROM entity_types
      WHERE organization_id = ${userOrg.id}
      ORDER BY slug
    `;
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(['tax_year', 'transaction']);
    for (const row of rows) {
      expect(row.managed_by_template_agent_id).toBe(templateAgent.agentId);
      expect(row.source_template_org_id).toBe(templateOrg.id);
    }
  });

  it('mirrors relationship types with managed_by_template_agent_id set', async () => {
    const sql = getTestDb();
    const rows = await sql`
      SELECT slug, managed_by_template_agent_id, source_template_org_id
      FROM entity_relationship_types
      WHERE organization_id = ${userOrg.id}
      ORDER BY slug
    `;
    expect(rows.map((r: { slug: string }) => r.slug)).toEqual(['for_tax_year']);
    expect(rows[0].managed_by_template_agent_id).toBe(templateAgent.agentId);
  });

  it('mirrors watcher definitions with the installed agent as owner', async () => {
    const sql = getTestDb();
    const rows = await sql`
      SELECT
        w.slug,
        w.agent_id,
        w.connection_id,
        w.entity_ids,
        w.managed_by_template_agent_id,
        w.source_template_org_id,
        v.prompt,
        v.reactions_guidance
      FROM watchers w
      JOIN watcher_versions v ON v.id = w.current_version_id
      WHERE w.organization_id = ${userOrg.id}
        AND w.slug = 'gmail-tx'
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].managed_by_template_agent_id).toBe(templateAgent.agentId);
    expect(rows[0].source_template_org_id).toBe(templateOrg.id);
    expect(rows[0].connection_id).toBeNull();
    expect(rows[0].entity_ids).toBeNull();
    expect(rows[0].agent_id).toBeTruthy();
    expect(rows[0].prompt).toContain('{{sources.gmail_messages}}');
    expect(rows[0].reactions_guidance).toContain('transaction');
  });

  it('mirrors watcher-scoped classifiers and their current version', async () => {
    const sql = getTestDb();
    const rows = await sql`
      SELECT
        c.slug,
        c.watcher_id,
        c.managed_by_template_agent_id,
        v.version,
        v.is_current,
        v.fallback_value,
        v.extraction_config
      FROM event_classifiers c
      JOIN event_classifier_versions v ON v.classifier_id = c.id
      WHERE c.organization_id = ${userOrg.id}
        AND c.slug = 'tax-relevance'
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].managed_by_template_agent_id).toBe(templateAgent.agentId);
    expect(rows[0].watcher_id).toBeTruthy();
    expect(rows[0].version).toBe(1);
    expect(rows[0].is_current).toBe(true);
    expect(rows[0].fallback_value).toBe('none');
    expect(rows[0].extraction_config).toEqual({ mode: 'llm' });
  });

  it('is idempotent: re-installing updates rather than creating duplicates', async () => {
    const result = await installAgentFromTemplate({
      templateAgentId: templateAgent.agentId,
      targetOrganizationId: userOrg.id,
      userId: user.id,
    });
    expect(result.created).toBe(false);

    const sql = getTestDb();
    const agentCount = await sql`
      SELECT COUNT(*)::int AS count
      FROM agents
      WHERE template_agent_id = ${templateAgent.agentId}
        AND organization_id = ${userOrg.id}
    `;
    expect(agentCount[0].count).toBe(1);

    const typeCount = await sql`
      SELECT COUNT(*)::int AS count
      FROM entity_types
      WHERE organization_id = ${userOrg.id}
        AND managed_by_template_agent_id = ${templateAgent.agentId}
    `;
    expect(typeCount[0].count).toBe(2);

    const watcherCount = await sql`
      SELECT COUNT(*)::int AS count
      FROM watchers
      WHERE organization_id = ${userOrg.id}
        AND managed_by_template_agent_id = ${templateAgent.agentId}
    `;
    expect(watcherCount[0].count).toBe(1);

    const classifierCount = await sql`
      SELECT COUNT(*)::int AS count
      FROM event_classifiers
      WHERE organization_id = ${userOrg.id}
        AND managed_by_template_agent_id = ${templateAgent.agentId}
    `;
    expect(classifierCount[0].count).toBe(1);
  });

  it('re-sync propagates template changes to the mirror', async () => {
    const sql = getTestDb();
    // Simulate a template-side description change.
    await sql`
      UPDATE entity_types
      SET description = 'UK fiscal year (6 April to 5 April)'
      WHERE organization_id = ${templateOrg.id}
        AND slug = 'tax_year'
    `;

    const installed = await sql`
      SELECT id FROM agents
      WHERE template_agent_id = ${templateAgent.agentId}
        AND organization_id = ${userOrg.id}
      LIMIT 1
    `;
    await resyncInstalledAgent({
      installedAgentId: installed[0].id as string,
      userId: user.id,
    });

    const mirrored = await sql`
      SELECT description FROM entity_types
      WHERE organization_id = ${userOrg.id}
        AND slug = 'tax_year'
    `;
    expect(mirrored[0].description).toBe('UK fiscal year (6 April to 5 April)');
  });

  it('refuses to install a template from a private org', async () => {
    const privateTemplateOrg = await createTestOrganization({ name: 'Private Template' });
    const privateTemplateAgent = await createTestAgent({
      organizationId: privateTemplateOrg.id,
      name: 'Private Template Agent',
    });

    await expect(
      installAgentFromTemplate({
        templateAgentId: privateTemplateAgent.agentId,
        targetOrganizationId: userOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/organization is not public/);
  });

  it('refuses to install an already-installed agent as a source template', async () => {
    const sql = getTestDb();
    const installed = await sql`
      SELECT id FROM agents
      WHERE template_agent_id = ${templateAgent.agentId}
        AND organization_id = ${userOrg.id}
      LIMIT 1
    `;
    const otherOrg = await createTestOrganization({ name: 'Other Install Target' });

    await expect(
      installAgentFromTemplate({
        templateAgentId: installed[0].id as string,
        targetOrganizationId: otherOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/cannot be used as a source template/);
  });

  it('refuses to install into the template org itself', async () => {
    await expect(
      installAgentFromTemplate({
        templateAgentId: templateAgent.agentId,
        targetOrganizationId: templateOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/Cannot install template agent into its own org/);
  });

  it('refuses to install when the user is not a member of the target org', async () => {
    const strangerOrg = await createTestOrganization({ name: 'Stranger Org' });
    await expect(
      installAgentFromTemplate({
        templateAgentId: templateAgent.agentId,
        targetOrganizationId: strangerOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/not a member/);
  });

  it('refuses to install when the user is a member but lacks admin/owner role', async () => {
    const memberOrg = await createTestOrganization({ name: 'Member-Only Org' });
    await addUserToOrganization(user.id, memberOrg.id, 'member');
    await expect(
      installAgentFromTemplate({
        templateAgentId: templateAgent.agentId,
        targetOrganizationId: memberOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/owner or admin role/);
  });

  it('refuses to overwrite a user-authored row of the same slug', async () => {
    const sql = getTestDb();
    const otherOrg = await createTestOrganization({ name: 'Other User Org' });
    await addUserToOrganization(user.id, otherOrg.id, 'owner');
    await sql`
      INSERT INTO entity_types (slug, name, description, metadata_schema, organization_id, created_by)
      VALUES ('transaction', 'User Transaction', 'Manual row', '{"type":"object"}'::jsonb, ${otherOrg.id}, ${user.id})
    `;
    await expect(
      installAgentFromTemplate({
        templateAgentId: templateAgent.agentId,
        targetOrganizationId: otherOrg.id,
        userId: user.id,
      })
    ).rejects.toThrow(/user-authored/);
  });
});
