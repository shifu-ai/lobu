/**
 * Install a template agent into a target organization.
 *
 * A template agent (e.g. the `personal-finance` agent in examples/) lives in a
 * template org and owns a canonical set of entity types and relationship types
 * that define its data model. When a user installs the agent we:
 *
 *   1. Create a new agents row in the user's org with template_agent_id set
 *      (Lobu's existing template-inheritance applies to agents.* settings —
 *      prompt, tools, mcp_servers, etc. — without any copy step).
 *   2. Mirror the template org's entity_types, entity_relationship_types,
 *      classifiers and watcher definitions into the user's org, tagged
 *      managed_by_template_agent_id so we can re-sync on template updates and
 *      treat them as read-only from the user's side.
 *
 * Watcher/classifier mirrors copy definitions only — not historical windows,
 * reactions or classifications.
 * The install is idempotent: re-running against the same target simply
 * UPDATEs the mirror rows (allowing template schema evolution).
 *
 * Safety: the mirror never overwrites rows the user authored directly
 * (managed_by_template_agent_id IS NULL). Slug collisions of that kind
 * abort the install with a descriptive error.
 */

import { generateSecureToken } from '../auth/oauth/utils';
import { type DbClient, getDb, pgTextArray } from '../db/client';

export interface InstallResult {
  agentId: string;
  organizationId: string;
  mirrored: {
    entity_types: number;
    entity_relationship_types: number;
    event_classifiers: number;
    watchers: number;
  };
  created: boolean;
}

export interface InstallAgentParams {
  templateAgentId: string;
  targetOrganizationId: string;
  userId: string;
  /** Optional override for the installed agent's display name. */
  name?: string;
}

type Sql = DbClient;

interface TemplateAgentRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  template_agent_id: string | null;
  organization_visibility: string;
}

async function loadTemplateAgent(sql: Sql, templateAgentId: string): Promise<TemplateAgentRow> {
  const rows = await sql`
    SELECT
      a.id,
      a.organization_id,
      a.name,
      a.description,
      a.template_agent_id,
      o.visibility AS organization_visibility
    FROM agents a
    JOIN "organization" o ON o.id = a.organization_id
    WHERE a.id = ${templateAgentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error(`Template agent ${templateAgentId} not found`);
  }
  return rows[0] as TemplateAgentRow;
}

async function findExistingInstall(
  sql: Sql,
  templateAgentId: string,
  targetOrganizationId: string
): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM agents
    WHERE template_agent_id = ${templateAgentId}
      AND organization_id = ${targetOrganizationId}
    LIMIT 1
  `;
  return rows.length > 0 ? (rows[0].id as string) : null;
}

async function upsertInstalledAgent(
  sql: Sql,
  params: {
    existingAgentId: string | null;
    template: TemplateAgentRow;
    targetOrganizationId: string;
    userId: string;
    name?: string;
  }
): Promise<{ agentId: string; created: boolean }> {
  if (params.existingAgentId) {
    await sql`
      UPDATE agents
      SET updated_at = NOW(),
          name = ${params.name ?? params.template.name},
          description = ${params.template.description}
      WHERE id = ${params.existingAgentId}
    `;
    return { agentId: params.existingAgentId, created: false };
  }

  const agentId = `agent_${generateSecureToken(8).toLowerCase()}`;
  await sql`
    INSERT INTO agents (
      id, organization_id, name, description,
      owner_platform, owner_user_id,
      template_agent_id,
      is_workspace_agent,
      created_at, updated_at
    ) VALUES (
      ${agentId},
      ${params.targetOrganizationId},
      ${params.name ?? params.template.name},
      ${params.template.description},
      'owletto',
      ${params.userId},
      ${params.template.id},
      false,
      NOW(), NOW()
    )
  `;
  return { agentId, created: true };
}

interface EntityTypeRow {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  metadata_schema: Record<string, unknown> | null;
  event_kinds: Record<string, unknown> | null;
}

async function mirrorEntityTypes(
  sql: Sql,
  templateOrgId: string,
  targetOrgId: string,
  templateAgentId: string,
  userId: string
): Promise<number> {
  const templateRows = (await sql`
    SELECT slug, name, description, icon, color, metadata_schema, event_kinds
    FROM entity_types
    WHERE organization_id = ${templateOrgId}
      AND deleted_at IS NULL
  `) as EntityTypeRow[];

  let count = 0;
  for (const row of templateRows) {
    const existing = await sql`
      SELECT id, managed_by_template_agent_id
      FROM entity_types
      WHERE organization_id = ${targetOrgId}
        AND slug = ${row.slug}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    const metadataSchema = row.metadata_schema ? sql.json(row.metadata_schema) : null;
    const eventKinds = row.event_kinds ? sql.json(row.event_kinds) : null;

    if (existing.length === 0) {
      await sql`
        INSERT INTO entity_types (
          slug, name, description, icon, color,
          metadata_schema, event_kinds,
          organization_id, created_by,
          managed_by_template_agent_id, source_template_org_id,
          created_at, updated_at
        ) VALUES (
          ${row.slug}, ${row.name}, ${row.description},
          ${row.icon}, ${row.color},
          ${metadataSchema}, ${eventKinds},
          ${targetOrgId}, ${userId},
          ${templateAgentId}, ${templateOrgId},
          NOW(), NOW()
        )
      `;
      count++;
      continue;
    }

    const existingOwner = existing[0].managed_by_template_agent_id as string | null;
    if (existingOwner === null) {
      throw new Error(
        `Entity type '${row.slug}' already exists in the target org as a user-authored row. Remove it or rename before installing this agent.`
      );
    }
    if (existingOwner !== templateAgentId) {
      throw new Error(
        `Entity type '${row.slug}' is already managed by a different template agent (${existingOwner}).`
      );
    }

    await sql`
      UPDATE entity_types
      SET name = ${row.name},
          description = ${row.description},
          icon = ${row.icon},
          color = ${row.color},
          metadata_schema = ${metadataSchema},
          event_kinds = ${eventKinds},
          updated_at = NOW(),
          updated_by = ${userId}
      WHERE id = ${existing[0].id}
    `;
    count++;
  }
  return count;
}

interface RelationshipTypeRow {
  slug: string;
  name: string;
  description: string | null;
  metadata_schema: Record<string, unknown> | null;
  is_symmetric: boolean;
}

async function mirrorRelationshipTypes(
  sql: Sql,
  templateOrgId: string,
  targetOrgId: string,
  templateAgentId: string,
  userId: string
): Promise<number> {
  const templateRows = (await sql`
    SELECT slug, name, description, metadata_schema, is_symmetric
    FROM entity_relationship_types
    WHERE organization_id = ${templateOrgId}
      AND status = 'active'
  `) as RelationshipTypeRow[];

  let count = 0;
  for (const row of templateRows) {
    const existing = await sql`
      SELECT id, managed_by_template_agent_id
      FROM entity_relationship_types
      WHERE organization_id = ${targetOrgId}
        AND slug = ${row.slug}
        AND status = 'active'
      LIMIT 1
    `;

    const metadataSchema = row.metadata_schema ? sql.json(row.metadata_schema) : null;

    if (existing.length === 0) {
      await sql`
        INSERT INTO entity_relationship_types (
          slug, name, description, metadata_schema,
          is_symmetric, organization_id, created_by,
          managed_by_template_agent_id, source_template_org_id,
          status, created_at, updated_at
        ) VALUES (
          ${row.slug}, ${row.name}, ${row.description}, ${metadataSchema},
          ${row.is_symmetric}, ${targetOrgId}, ${userId},
          ${templateAgentId}, ${templateOrgId},
          'active', NOW(), NOW()
        )
      `;
      count++;
      continue;
    }

    const existingOwner = existing[0].managed_by_template_agent_id as string | null;
    if (existingOwner === null) {
      throw new Error(
        `Relationship type '${row.slug}' already exists in the target org as a user-authored row. Remove it or rename before installing this agent.`
      );
    }
    if (existingOwner !== templateAgentId) {
      throw new Error(
        `Relationship type '${row.slug}' is already managed by a different template agent (${existingOwner}).`
      );
    }

    await sql`
      UPDATE entity_relationship_types
      SET name = ${row.name},
          description = ${row.description},
          metadata_schema = ${metadataSchema},
          is_symmetric = ${row.is_symmetric},
          updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
    count++;
  }
  return count;
}

interface TemplateWatcherRow {
  id: number;
  model_config: Record<string, unknown> | null;
  sources: unknown[] | null;
  reaction_script: string | null;
  reaction_script_compiled: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  version: number | null;
  tags: string[] | null;
  registry_type: string | null;
  registry_repo: string | null;
  registry_ref: string | null;
  current_version_id: number | null;
  schedule: string | null;
}

interface TemplateWatcherVersionRow {
  id: number;
  version: number;
  name: string;
  description: string | null;
  change_notes: string | null;
  sources_schema: Record<string, unknown> | null;
  keying_config: Record<string, unknown> | null;
  json_template: Record<string, unknown> | null;
  prompt: string;
  extraction_schema: Record<string, unknown>;
  classifiers: Record<string, unknown> | null;
  required_source_types: string[] | null;
  recommended_source_types: string[] | null;
  source_repository: string | null;
  source_ref: string | null;
  source_commit_sha: string | null;
  source_path: string | null;
  reactions_guidance: string | null;
  condensation_prompt: string | null;
  condensation_window_count: number | null;
  version_sources: Record<string, unknown> | null;
}

function jsonOrNull(sql: Sql, value: unknown): unknown {
  return value == null ? null : sql.json(value);
}

async function loadCurrentWatcherVersion(
  sql: Sql,
  versionId: number | null
): Promise<TemplateWatcherVersionRow | null> {
  if (versionId === null) return null;
  const rows = (await sql`
    SELECT
      id,
      version,
      name,
      description,
      change_notes,
      sources_schema,
      keying_config,
      json_template,
      prompt,
      extraction_schema,
      classifiers,
      required_source_types,
      recommended_source_types,
      source_repository,
      source_ref,
      source_commit_sha,
      source_path,
      reactions_guidance,
      condensation_prompt,
      condensation_window_count,
      version_sources
    FROM watcher_versions
    WHERE id = ${versionId}
    LIMIT 1
  `) as TemplateWatcherVersionRow[];
  return rows[0] ?? null;
}

async function upsertWatcherVersion(
  sql: Sql,
  row: TemplateWatcherVersionRow,
  targetWatcherId: number,
  userId: string,
  existingVersionId: number | null
): Promise<number> {
  const sourcesSchema = jsonOrNull(sql, row.sources_schema);
  const keyingConfig = jsonOrNull(sql, row.keying_config);
  const jsonTemplate = jsonOrNull(sql, row.json_template);
  const extractionSchema = sql.json(row.extraction_schema);
  const classifiers = jsonOrNull(sql, row.classifiers);
  const versionSources = jsonOrNull(sql, row.version_sources);
  const requiredSourceTypes = pgTextArray(row.required_source_types ?? []);
  const recommendedSourceTypes = pgTextArray(row.recommended_source_types ?? []);

  if (existingVersionId !== null) {
    await sql`
      UPDATE watcher_versions
      SET version = ${row.version},
          name = ${row.name},
          description = ${row.description},
          change_notes = ${row.change_notes},
          sources_schema = ${sourcesSchema},
          keying_config = ${keyingConfig},
          json_template = ${jsonTemplate},
          prompt = ${row.prompt},
          extraction_schema = ${extractionSchema},
          classifiers = ${classifiers},
          required_source_types = ${requiredSourceTypes}::text[],
          recommended_source_types = ${recommendedSourceTypes}::text[],
          source_repository = ${row.source_repository},
          source_ref = ${row.source_ref},
          source_commit_sha = ${row.source_commit_sha},
          source_path = ${row.source_path},
          reactions_guidance = ${row.reactions_guidance},
          condensation_prompt = ${row.condensation_prompt},
          condensation_window_count = ${row.condensation_window_count ?? 4},
          version_sources = ${versionSources}
      WHERE id = ${existingVersionId}
    `;
    return existingVersionId;
  }

  const inserted = await sql`
    INSERT INTO watcher_versions (
      version, name, description, change_notes, created_by,
      sources_schema, keying_config, json_template, prompt, extraction_schema,
      classifiers, required_source_types, recommended_source_types,
      source_repository, source_ref, source_commit_sha, source_path,
      reactions_guidance, condensation_prompt, condensation_window_count,
      watcher_id, version_sources
    ) VALUES (
      ${row.version}, ${row.name}, ${row.description}, ${row.change_notes}, ${userId},
      ${sourcesSchema}, ${keyingConfig}, ${jsonTemplate}, ${row.prompt}, ${extractionSchema},
      ${classifiers}, ${requiredSourceTypes}::text[], ${recommendedSourceTypes}::text[],
      ${row.source_repository}, ${row.source_ref}, ${row.source_commit_sha}, ${row.source_path},
      ${row.reactions_guidance}, ${row.condensation_prompt}, ${row.condensation_window_count ?? 4},
      ${targetWatcherId}, ${versionSources}
    )
    RETURNING id
  `;
  return inserted[0].id as number;
}

async function mirrorWatchers(
  sql: Sql,
  templateOrgId: string,
  targetOrgId: string,
  templateAgentId: string,
  installedAgentId: string,
  userId: string
): Promise<{ count: number; watcherIdsByTemplateId: Map<number, number> }> {
  const templateRows = (await sql`
    SELECT
      id,
      model_config,
      sources,
      reaction_script,
      reaction_script_compiled,
      name,
      slug,
      description,
      version,
      tags,
      registry_type,
      registry_repo,
      registry_ref,
      current_version_id,
      schedule
    FROM watchers
    WHERE organization_id = ${templateOrgId}
      AND status = 'active'
  `) as TemplateWatcherRow[];

  let count = 0;
  const watcherIdsByTemplateId = new Map<number, number>();

  for (const row of templateRows) {
    if (!row.slug) {
      throw new Error(`Template watcher ${row.id} has no slug — cannot mirror it safely.`);
    }

    const existing = await sql`
      SELECT id, managed_by_template_agent_id, current_version_id
      FROM watchers
      WHERE organization_id = ${targetOrgId}
        AND slug = ${row.slug}
        AND status = 'active'
      LIMIT 1
    `;

    const modelConfig = sql.json(row.model_config ?? {});
    const sources = sql.json(row.sources ?? []);
    const tags = pgTextArray(row.tags ?? []);
    let targetWatcherId: number;
    let existingVersionId: number | null = null;

    if (existing.length === 0) {
      const inserted = await sql`
        INSERT INTO watchers (
          model_config, status, sources, created_by, entity_ids,
          reaction_script, reaction_script_compiled, organization_id,
          name, slug, description, version, tags,
          registry_type, registry_repo, registry_ref,
          schedule, next_run_at, agent_id, connection_id, scheduler_client_id,
          managed_by_template_agent_id, source_template_org_id,
          created_at, updated_at
        ) VALUES (
          ${modelConfig}, 'active', ${sources}, ${userId}, NULL,
          ${row.reaction_script}, ${row.reaction_script_compiled}, ${targetOrgId},
          ${row.name}, ${row.slug}, ${row.description}, ${row.version ?? 1}, ${tags}::text[],
          ${row.registry_type}, ${row.registry_repo}, ${row.registry_ref},
          ${row.schedule}, NULL, ${installedAgentId}, NULL, NULL,
          ${templateAgentId}, ${templateOrgId},
          NOW(), NOW()
        )
        RETURNING id
      `;
      targetWatcherId = inserted[0].id as number;
    } else {
      const existingOwner = existing[0].managed_by_template_agent_id as string | null;
      if (existingOwner === null) {
        throw new Error(
          `Watcher '${row.slug}' already exists in the target org as a user-authored row. Remove it or rename before installing this agent.`
        );
      }
      if (existingOwner !== templateAgentId) {
        throw new Error(
          `Watcher '${row.slug}' is already managed by a different template agent (${existingOwner}).`
        );
      }
      targetWatcherId = existing[0].id as number;
      existingVersionId = (existing[0].current_version_id as number | null) ?? null;
      await sql`
        UPDATE watchers
        SET model_config = ${modelConfig},
            sources = ${sources},
            reaction_script = ${row.reaction_script},
            reaction_script_compiled = ${row.reaction_script_compiled},
            name = ${row.name},
            description = ${row.description},
            version = ${row.version ?? 1},
            tags = ${tags}::text[],
            registry_type = ${row.registry_type},
            registry_repo = ${row.registry_repo},
            registry_ref = ${row.registry_ref},
            schedule = ${row.schedule},
            next_run_at = NULL,
            agent_id = ${installedAgentId},
            connection_id = NULL,
            scheduler_client_id = NULL,
            updated_at = NOW()
        WHERE id = ${targetWatcherId}
      `;
    }

    const version = await loadCurrentWatcherVersion(sql, row.current_version_id);
    if (version) {
      const targetVersionId = await upsertWatcherVersion(
        sql,
        version,
        targetWatcherId,
        userId,
        existingVersionId
      );
      await sql`
        UPDATE watchers
        SET current_version_id = ${targetVersionId}, updated_at = NOW()
        WHERE id = ${targetWatcherId}
      `;
    }

    watcherIdsByTemplateId.set(row.id, targetWatcherId);
    count++;
  }

  return { count, watcherIdsByTemplateId };
}

interface TemplateClassifierRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  attribute_key: string;
  watcher_id: number | null;
}

interface TemplateClassifierVersionRow {
  version: number;
  is_current: boolean;
  attribute_values: Record<string, unknown>;
  min_similarity: string | number | null;
  fallback_value: string | null;
  change_notes: string | null;
  preferred_model: string | null;
  extraction_config: Record<string, unknown> | null;
}

async function loadCurrentClassifierVersion(
  sql: Sql,
  classifierId: number
): Promise<TemplateClassifierVersionRow | null> {
  const rows = (await sql`
    SELECT
      version,
      is_current,
      attribute_values,
      min_similarity,
      fallback_value,
      change_notes,
      preferred_model,
      extraction_config
    FROM event_classifier_versions
    WHERE classifier_id = ${classifierId}
      AND is_current = true
    ORDER BY version DESC
    LIMIT 1
  `) as TemplateClassifierVersionRow[];
  return rows[0] ?? null;
}

async function upsertClassifierVersion(
  sql: Sql,
  row: TemplateClassifierVersionRow,
  targetClassifierId: number,
  userId: string
): Promise<void> {
  const attributeValues = sql.json(row.attribute_values);
  const extractionConfig = jsonOrNull(sql, row.extraction_config);

  await sql`
    UPDATE event_classifier_versions
    SET is_current = false
    WHERE classifier_id = ${targetClassifierId}
  `;

  const existing = await sql`
    SELECT id FROM event_classifier_versions
    WHERE classifier_id = ${targetClassifierId}
      AND version = ${row.version}
    LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE event_classifier_versions
      SET is_current = true,
          attribute_values = ${attributeValues},
          min_similarity = ${row.min_similarity},
          fallback_value = ${row.fallback_value},
          change_notes = ${row.change_notes},
          preferred_model = ${row.preferred_model},
          extraction_config = ${extractionConfig}
      WHERE id = ${existing[0].id}
    `;
    return;
  }

  await sql`
    INSERT INTO event_classifier_versions (
      classifier_id, version, is_current, attribute_values, min_similarity,
      fallback_value, change_notes, created_by, preferred_model, extraction_config
    ) VALUES (
      ${targetClassifierId}, ${row.version}, true, ${attributeValues}, ${row.min_similarity},
      ${row.fallback_value}, ${row.change_notes}, ${userId}, ${row.preferred_model}, ${extractionConfig}
    )
  `;
}

async function mirrorEventClassifiers(
  sql: Sql,
  templateOrgId: string,
  targetOrgId: string,
  templateAgentId: string,
  userId: string,
  watcherIdsByTemplateId: Map<number, number>
): Promise<number> {
  const templateRows = (await sql`
    SELECT id, slug, name, description, attribute_key, watcher_id
    FROM event_classifiers
    WHERE organization_id = ${templateOrgId}
      AND status = 'active'
  `) as TemplateClassifierRow[];

  let count = 0;
  for (const row of templateRows) {
    const targetWatcherId = row.watcher_id ? watcherIdsByTemplateId.get(row.watcher_id) : null;
    if (row.watcher_id && !targetWatcherId) {
      continue;
    }

    const existing = await sql`
      SELECT id, managed_by_template_agent_id
      FROM event_classifiers
      WHERE organization_id = ${targetOrgId}
        AND slug = ${row.slug}
        AND status = 'active'
        AND (
          (${targetWatcherId ?? null}::int IS NULL AND watcher_id IS NULL)
          OR watcher_id = ${targetWatcherId ?? null}
        )
      LIMIT 1
    `;

    let targetClassifierId: number;
    if (existing.length === 0) {
      const inserted = await sql`
        INSERT INTO event_classifiers (
          slug, name, description, attribute_key, status,
          created_by, entity_id, watcher_id, organization_id, entity_ids,
          managed_by_template_agent_id, source_template_org_id,
          created_at, updated_at
        ) VALUES (
          ${row.slug}, ${row.name}, ${row.description}, ${row.attribute_key}, 'active',
          ${userId}, NULL, ${targetWatcherId ?? null}, ${targetOrgId}, NULL,
          ${templateAgentId}, ${templateOrgId},
          NOW(), NOW()
        )
        RETURNING id
      `;
      targetClassifierId = inserted[0].id as number;
    } else {
      const existingOwner = existing[0].managed_by_template_agent_id as string | null;
      if (existingOwner === null) {
        throw new Error(
          `Classifier '${row.slug}' already exists in the target org as a user-authored row. Remove it or rename before installing this agent.`
        );
      }
      if (existingOwner !== templateAgentId) {
        throw new Error(
          `Classifier '${row.slug}' is already managed by a different template agent (${existingOwner}).`
        );
      }
      targetClassifierId = existing[0].id as number;
      await sql`
        UPDATE event_classifiers
        SET name = ${row.name},
            description = ${row.description},
            attribute_key = ${row.attribute_key},
            watcher_id = ${targetWatcherId ?? null},
            entity_id = NULL,
            entity_ids = NULL,
            updated_at = NOW()
        WHERE id = ${targetClassifierId}
      `;
    }

    const version = await loadCurrentClassifierVersion(sql, row.id);
    if (version) {
      await upsertClassifierVersion(sql, version, targetClassifierId, userId);
    }
    count++;
  }
  return count;
}

export async function installAgentFromTemplate(
  params: InstallAgentParams
): Promise<InstallResult> {
  const sql = getDb();
  const template = await loadTemplateAgent(sql, params.templateAgentId);

  if (template.template_agent_id) {
    throw new Error(
      `Agent ${params.templateAgentId} is itself installed from a template and cannot be used as a source template.`
    );
  }

  if (template.organization_visibility !== 'public') {
    throw new Error(
      `Template agent ${params.templateAgentId} is not installable because its organization is not public.`
    );
  }

  if (template.organization_id === params.targetOrganizationId) {
    throw new Error(
      `Cannot install template agent into its own org (${template.organization_id}). Pick a different target.`
    );
  }

  const membership = await sql<{ role: string }[]>`
    SELECT role FROM "member"
    WHERE "organizationId" = ${params.targetOrganizationId}
      AND "userId" = ${params.userId}
    LIMIT 1
  `;
  if (membership.length === 0) {
    throw new Error(
      `User ${params.userId} is not a member of organization ${params.targetOrganizationId}.`
    );
  }
  if (membership[0].role !== 'owner' && membership[0].role !== 'admin') {
    throw new Error(
      `Installing a template agent requires owner or admin role in organization ${params.targetOrganizationId}.`
    );
  }

  let result: InstallResult | null = null;

  await sql.begin(async (tx) => {
    const existingAgentId = await findExistingInstall(
      tx,
      params.templateAgentId,
      params.targetOrganizationId
    );
    const upsert = await upsertInstalledAgent(tx, {
      existingAgentId,
      template,
      targetOrganizationId: params.targetOrganizationId,
      userId: params.userId,
      name: params.name,
    });

    const entityTypes = await mirrorEntityTypes(
      tx,
      template.organization_id,
      params.targetOrganizationId,
      params.templateAgentId,
      params.userId
    );
    const relationshipTypes = await mirrorRelationshipTypes(
      tx,
      template.organization_id,
      params.targetOrganizationId,
      params.templateAgentId,
      params.userId
    );
    const watcherMirror = await mirrorWatchers(
      tx,
      template.organization_id,
      params.targetOrganizationId,
      params.templateAgentId,
      upsert.agentId,
      params.userId
    );
    const classifiers = await mirrorEventClassifiers(
      tx,
      template.organization_id,
      params.targetOrganizationId,
      params.templateAgentId,
      params.userId,
      watcherMirror.watcherIdsByTemplateId
    );

    result = {
      agentId: upsert.agentId,
      organizationId: params.targetOrganizationId,
      mirrored: {
        entity_types: entityTypes,
        entity_relationship_types: relationshipTypes,
        event_classifiers: classifiers,
        watchers: watcherMirror.count,
      },
      created: upsert.created,
    };
  });

  if (!result) {
    throw new Error('Install transaction did not produce a result');
  }
  return result;
}

export async function resyncInstalledAgent(params: {
  installedAgentId: string;
  userId: string;
}): Promise<InstallResult> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, organization_id, template_agent_id
    FROM agents
    WHERE id = ${params.installedAgentId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error(`Installed agent ${params.installedAgentId} not found`);
  }
  const row = rows[0] as {
    id: string;
    organization_id: string;
    template_agent_id: string | null;
  };
  if (!row.template_agent_id) {
    throw new Error(
      `Agent ${params.installedAgentId} has no template_agent_id — nothing to re-sync.`
    );
  }
  return installAgentFromTemplate({
    templateAgentId: row.template_agent_id,
    targetOrganizationId: row.organization_id,
    userId: params.userId,
  });
}
