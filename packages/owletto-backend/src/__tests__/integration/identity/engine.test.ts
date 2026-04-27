/**
 * Identity engine integration tests.
 *
 * Covers UC1 / UC4 / UC5 / UC6 / UC8 / UC10 from the F1 design plan plus
 * basic schema-validation guards. Each test runs against a freshly-cleaned
 * test DB; the pglite backend is fast enough that the per-test setup cost
 * is acceptable.
 *
 * The engine's job is narrow: given a `$member` and a batch of facts,
 * persist facts as fact-typed events, supersede prior facts, derive
 * relationships per relationship-type rules, and revoke stale derivations.
 * Adoption (binding the user to a curated `$member`) lives upstream — these
 * tests pre-create the `$member` directly.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ingestFacts,
  ruleHashFor,
} from '../../../identity/engine';
import {
  IDENTITY_FACT_SEMANTIC_TYPE,
  CLAIM_COLLISION_SEMANTIC_TYPE,
  type AutoCreateWhenRule,
  type ConnectorFact,
} from '@lobu/owletto-sdk';
import { IdentitySchemaError } from '../../../identity/validate';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

interface TestRelationshipType {
  id: number;
  slug: string;
  ruleVersion: number;
  ruleHash: string;
}

async function createPublicCatalog(name: string) {
  return createTestOrganization({ name, visibility: 'public' });
}

async function createRelationshipTypeWithRules(options: {
  organizationId: string;
  slug: string;
  name: string;
  rules: AutoCreateWhenRule[];
  ruleVersion?: number;
}): Promise<TestRelationshipType> {
  const sql = getTestDb();
  const ruleVersion = options.ruleVersion ?? 1;
  const ruleHash = ruleHashFor(options.rules);
  const metadata = {
    autoCreateWhen: options.rules,
    ruleVersion,
    ruleHash,
  };
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO entity_relationship_types (
      organization_id, slug, name, is_symmetric, status, metadata, created_at, updated_at
    ) VALUES (
      ${options.organizationId},
      ${options.slug},
      ${options.name},
      false,
      'active',
      ${sql.json(metadata)},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  return {
    id: Number(row.id),
    slug: options.slug,
    ruleVersion,
    ruleHash,
  };
}

async function createMemberEntity(options: {
  organizationId: string;
  userId: string;
  email: string;
  name: string;
}) {
  const sql = getTestDb();
  // Ensure $member entity_type exists in this org.
  let typeRows = await sql<{ id: number }[]>`
    SELECT id FROM entity_types
    WHERE slug = '$member' AND organization_id = ${options.organizationId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (typeRows.length === 0) {
    typeRows = await sql<{ id: number }[]>`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${options.organizationId}, '$member', 'Member', current_timestamp, current_timestamp)
      RETURNING id
    `;
  }
  const [inserted] = await sql<{ id: number }[]>`
    INSERT INTO entities (
      name, slug, entity_type_id, organization_id, metadata, created_by, created_at, updated_at
    ) VALUES (
      ${options.name},
      ${`member-${options.userId.slice(-8)}`},
      ${typeRows[0].id},
      ${options.organizationId},
      ${sql.json({ email: options.email, name: options.name })},
      ${options.userId},
      NOW(), NOW()
    )
    RETURNING id
  `;
  return Number(inserted.id);
}

async function getEvent(id: number) {
  const sql = getTestDb();
  const rows = await sql<{
    id: string;
    semantic_type: string;
    metadata: Record<string, unknown>;
    supersedes_event_id: string | null;
  }[]>`
    SELECT id, semantic_type, metadata, supersedes_event_id
    FROM events WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    semantic_type: r.semantic_type,
    metadata: r.metadata,
    supersedes_event_id: r.supersedes_event_id !== null ? Number(r.supersedes_event_id) : null,
  };
}

async function getRelationship(id: number) {
  const sql = getTestDb();
  const rows = await sql<{
    id: string;
    from_entity_id: string;
    to_entity_id: string;
    relationship_type_id: string;
    metadata: Record<string, unknown>;
    deleted_at: string | null;
  }[]>`
    SELECT id, from_entity_id, to_entity_id, relationship_type_id, metadata, deleted_at
    FROM entity_relationships WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    from_entity_id: Number(r.from_entity_id),
    to_entity_id: Number(r.to_entity_id),
    relationship_type_id: Number(r.relationship_type_id),
    metadata: r.metadata,
    deleted_at: r.deleted_at,
  };
}

describe('identity engine — facts ingestion', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('UC1: persists a fact event and derives a relationship to a metadata-matching catalog entity', async () => {
    const market = await createPublicCatalog('Market UC1');
    const tenant = await createTestOrganization({ name: 'Tenant UC1', visibility: 'private' });
    const user = await createTestUser({ email: 'albertpai@bolt.new' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Albert Pai',
    });

    const company = await createTestEntity({
      name: 'Bolt.new',
      entity_type: 'company',
      organization_id: market.id,
      domain: 'bolt.new',
      created_by: user.id,
    });

    const works_at = await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'works_at',
      name: 'Works at',
      rules: [
        {
          sourceNamespace: 'hosted_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const fact: ConnectorFact = {
      namespace: 'hosted_domain',
      identifier: 'bolt.new',
      normalizedValue: 'bolt.new',
      assurance: 'oauth_verified',
      providerStableId: 'google:sub:106789',
      sourceAccountId: 'acct_uc1_google',
    };

    const result = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'google_workspace',
      facts: [fact],
      options: { shadow: false },
    });

    expect(result.factEventIds).toHaveLength(1);
    expect(result.derivedRelationshipIds).toHaveLength(1);
    expect(result.collisionEventIds).toHaveLength(0);

    const ev = await getEvent(result.factEventIds[0]);
    expect(ev?.semantic_type).toBe(IDENTITY_FACT_SEMANTIC_TYPE);
    expect(ev?.metadata.namespace).toBe('hosted_domain');
    expect(ev?.metadata.normalizedValue).toBe('bolt.new');
    expect(ev?.metadata.providerStableId).toBe('google:sub:106789');

    const rel = await getRelationship(result.derivedRelationshipIds[0]);
    expect(rel?.from_entity_id).toBe(memberEntityId);
    expect(rel?.to_entity_id).toBe(company.id);
    expect(rel?.relationship_type_id).toBe(works_at.id);
    expect(rel?.deleted_at).toBeNull();
    const derived = (rel?.metadata as { derivedFrom: { sourceEventId: number; ruleVersion: number } })
      .derivedFrom;
    expect(derived.sourceEventId).toBe(result.factEventIds[0]);
    expect(derived.ruleVersion).toBe(works_at.ruleVersion);
  });

  it('UC4: refresh that drops a namespace supersedes the fact and revokes the derivation', async () => {
    const market = await createPublicCatalog('Market UC4');
    const tenant = await createTestOrganization({ name: 'Tenant UC4', visibility: 'private' });
    const user = await createTestUser({ email: 'leaver@bolt.new' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Leaver',
    });
    const company = await createTestEntity({
      name: 'Bolt.new',
      entity_type: 'company',
      organization_id: market.id,
      domain: 'bolt.new',
      created_by: user.id,
    });
    await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'works_at',
      name: 'Works at',
      rules: [
        {
          sourceNamespace: 'hosted_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const initialFact: ConnectorFact = {
      namespace: 'hosted_domain',
      identifier: 'bolt.new',
      normalizedValue: 'bolt.new',
      assurance: 'oauth_verified',
      providerStableId: 'google:sub:leaver',
      sourceAccountId: 'acct_uc4_google',
    };
    const first = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'google_workspace',
      facts: [initialFact],
    });
    expect(first.derivedRelationshipIds).toHaveLength(1);

    // Refresh: connector emits no facts at all (user left Workspace, hosted_domain dropped).
    const refresh = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'google_workspace',
      facts: [
        // Provide an empty-domain fact via a different namespace to trigger the diff path.
        // We pass an `email` fact that's still valid; absence of `hosted_domain` is what we want to test.
        {
          namespace: 'email',
          identifier: 'leaver@personal.example',
          normalizedValue: 'leaver@personal.example',
          assurance: 'oauth_verified',
          providerStableId: 'google:sub:leaver',
          sourceAccountId: 'acct_uc4_google',
        },
      ],
    });

    expect(refresh.supersededEventIds).toContain(first.factEventIds[0]);
    expect(refresh.revokedRelationshipIds).toContain(first.derivedRelationshipIds[0]);

    const rel = await getRelationship(first.derivedRelationshipIds[0]);
    expect(rel?.deleted_at).not.toBeNull();
  });

  it('UC6: ambiguous match with strategy=unique_only surfaces a claim_collision event and skips derivation', async () => {
    const market = await createPublicCatalog('Market UC6');
    const tenant = await createTestOrganization({ name: 'Tenant UC6', visibility: 'private' });
    const user = await createTestUser({ email: 'ambiguous@bolt.new' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Ambiguous',
    });
    // Two founders, same linkedin URL (e.g. mistakenly duplicated). Use a
    // metadata field WITHOUT a unique-index constraint so the test can
    // create two rows that share the value — the engine's job is to
    // detect ambiguity at match time, not at write time.
    const sql = getTestDb();
    const founderA = await createTestEntity({
      name: 'Albert (canonical)',
      entity_type: 'founder',
      organization_id: market.id,
      created_by: user.id,
    });
    await sql`
      UPDATE entities SET metadata = metadata || ${sql.json({ linkedin_url: 'linkedin.com/in/albert' })}
      WHERE id = ${founderA.id}
    `;
    const founderB = await createTestEntity({
      name: 'Albert (duplicate)',
      entity_type: 'founder',
      organization_id: market.id,
      created_by: user.id,
    });
    await sql`
      UPDATE entities SET metadata = metadata || ${sql.json({ linkedin_url: 'linkedin.com/in/albert' })}
      WHERE id = ${founderB.id}
    `;

    await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'is_same_person_as',
      name: 'Is same person as',
      rules: [
        {
          sourceNamespace: 'linkedin_url',
          targetField: 'linkedin_url',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const result = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'linkedin',
      facts: [
        {
          namespace: 'linkedin_url',
          identifier: 'https://linkedin.com/in/albert',
          normalizedValue: 'linkedin.com/in/albert',
          assurance: 'oauth_verified',
          providerStableId: 'linkedin:12345',
          sourceAccountId: 'acct_uc6_linkedin',
        },
      ],
    });

    expect(result.derivedRelationshipIds).toHaveLength(0);
    expect(result.collisionEventIds).toHaveLength(1);
    expect(result.skippedRules.length).toBeGreaterThan(0);

    const ev = await getEvent(result.collisionEventIds[0]);
    expect(ev?.semantic_type).toBe(CLAIM_COLLISION_SEMANTIC_TYPE);
    const payload = ev?.metadata as {
      kind: string;
      candidateMemberIds: number[];
    };
    expect(payload.kind).toBe('identity_match');
    expect(payload.candidateMemberIds).toHaveLength(2);
  });

  it('UC8: rejects a fact whose assurance is below the rule requirement', async () => {
    const market = await createPublicCatalog('Market UC8');
    const tenant = await createTestOrganization({ name: 'Tenant UC8', visibility: 'private' });
    const user = await createTestUser({ email: 'lowtrust@example.com' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Lowtrust',
    });
    await createTestEntity({
      name: 'Bolt.new',
      entity_type: 'company',
      organization_id: market.id,
      domain: 'bolt.new',
      created_by: user.id,
    });
    await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'works_at',
      name: 'Works at',
      rules: [
        {
          sourceNamespace: 'hosted_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const result = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'cookies_only_connector',
      facts: [
        {
          namespace: 'hosted_domain',
          identifier: 'bolt.new',
          normalizedValue: 'bolt.new',
          assurance: 'cookie_session',
          providerStableId: 'cookie:abc',
          sourceAccountId: 'acct_uc8_cookies',
        },
      ],
    });

    expect(result.factEventIds).toHaveLength(1);
    expect(result.derivedRelationshipIds).toHaveLength(0);
    expect(result.skippedRules.some((s) => s.reason.includes('below required'))).toBe(true);
  });

  it('shadow mode: writes facts but skips derivation/revocation', async () => {
    const market = await createPublicCatalog('Market Shadow');
    const tenant = await createTestOrganization({ name: 'Tenant Shadow', visibility: 'private' });
    const user = await createTestUser({ email: 'shadow@bolt.new' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Shadow',
    });
    await createTestEntity({
      name: 'Bolt.new',
      entity_type: 'company',
      organization_id: market.id,
      domain: 'bolt.new',
      created_by: user.id,
    });
    await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'works_at',
      name: 'Works at',
      rules: [
        {
          sourceNamespace: 'hosted_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const result = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'google_workspace',
      facts: [
        {
          namespace: 'hosted_domain',
          identifier: 'bolt.new',
          normalizedValue: 'bolt.new',
          assurance: 'oauth_verified',
          providerStableId: 'google:sub:shadow',
          sourceAccountId: 'acct_shadow_google',
        },
      ],
      options: { shadow: true },
    });

    expect(result.factEventIds).toHaveLength(1);
    expect(result.derivedRelationshipIds).toHaveLength(0);
    expect(result.revokedRelationshipIds).toHaveLength(0);
    expect(result.collisionEventIds).toHaveLength(0);
  });

  it('rejects malformed facts with IdentitySchemaError before any side effects', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Malformed', visibility: 'private' });
    const user = await createTestUser({ email: 'malformed@example.com' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Malformed',
    });

    await expect(
      ingestFacts({
        tenantOrganizationId: tenant.id,
        memberEntityId,
        userId: user.id,
        connectorKey: 'broken',
        facts: [
          // Missing required fields.
          {
            namespace: '',
            identifier: '',
            normalizedValue: '',
            assurance: 'oauth_verified',
            providerStableId: '',
            sourceAccountId: '',
          } as ConnectorFact,
        ],
      })
    ).rejects.toBeInstanceOf(IdentitySchemaError);
  });

  it('UC5: same connector emitting an admin-tier namespace fires a separate is_admin_of rule', async () => {
    const market = await createPublicCatalog('Market UC5');
    const tenant = await createTestOrganization({ name: 'Tenant UC5', visibility: 'private' });
    const user = await createTestUser({ email: 'admin@bolt.new' });
    await addUserToOrganization(user.id, tenant.id, 'owner');
    const memberEntityId = await createMemberEntity({
      organizationId: tenant.id,
      userId: user.id,
      email: user.email,
      name: 'Admin User',
    });
    const company = await createTestEntity({
      name: 'Bolt.new',
      entity_type: 'company',
      organization_id: market.id,
      domain: 'bolt.new',
      created_by: user.id,
    });

    await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'works_at',
      name: 'Works at',
      rules: [
        {
          sourceNamespace: 'hosted_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified',
          matchStrategy: 'unique_only',
        },
      ],
    });
    const is_admin_of = await createRelationshipTypeWithRules({
      organizationId: market.id,
      slug: 'is_admin_of',
      name: 'Is admin of',
      rules: [
        {
          sourceNamespace: 'workspace_admin_domain',
          targetField: 'domain',
          assuranceRequired: 'oauth_verified_admin_role',
          matchStrategy: 'unique_only',
        },
      ],
    });

    const result = await ingestFacts({
      tenantOrganizationId: tenant.id,
      memberEntityId,
      userId: user.id,
      connectorKey: 'google_workspace',
      facts: [
        {
          namespace: 'hosted_domain',
          identifier: 'bolt.new',
          normalizedValue: 'bolt.new',
          assurance: 'oauth_verified',
          providerStableId: 'google:sub:admin',
          sourceAccountId: 'acct_uc5_google',
        },
        {
          namespace: 'workspace_admin_domain',
          identifier: 'bolt.new',
          normalizedValue: 'bolt.new',
          assurance: 'oauth_verified_admin_role',
          providerStableId: 'google:sub:admin',
          sourceAccountId: 'acct_uc5_google',
        },
      ],
    });

    expect(result.derivedRelationshipIds.length).toBeGreaterThanOrEqual(2);
    const sql = getTestDb();
    const rels = await sql<{
      id: number;
      relationship_type_id: number;
    }[]>`
      SELECT id, relationship_type_id
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
        AND to_entity_id = ${company.id}
        AND deleted_at IS NULL
    `;
    const relTypeIds = rels.map((r) => r.relationship_type_id);
    expect(relTypeIds).toContain(is_admin_of.id);
  });
});
