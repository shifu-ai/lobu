/**
 * Identity engine.
 *
 * Reads connector-emitted facts and resolves them against catalog entities:
 *  1. Persist each fact as an event row (semantic_type='identity_fact'),
 *     superseding the prior fact for the same (sourceAccountId, namespace).
 *  2. Look up entities in each public catalog whose identity-namespace
 *     metadata field equals the fact's normalizedValue.
 *  3. Apply each catalog's relationship-type auto_create_when rules,
 *     writing entity_relationships with provenance pointing back to the
 *     source event. Skip when assurance < required, when match strategy
 *     rejects ambiguity, or when the target relationship already exists.
 *  4. On supersede, revoke derivations whose source event is no longer
 *     current (status='archived' on the relationship row + valid_to=now).
 *
 * Shadow mode (env IDENTITY_ENGINE_SHADOW=='true'): writes facts but
 * skips derivation/revocation writes. Used to validate behaviour against
 * real users before flipping derivations on.
 */

import { createHash } from 'node:crypto';
import { getDb } from '../db/client';
import { insertEvent } from '../utils/insert-event';
import logger from '../utils/logger';
import {
  IDENTITY_FACT_SEMANTIC_TYPE,
  CLAIM_COLLISION_SEMANTIC_TYPE,
  assuranceMeets,
  type AssuranceLevel as AssuranceLevelValue,
} from '@lobu/owletto-sdk';
import type {
  AutoCreateWhenRule,
  ConnectorFactInput,
  DerivedFromProvenance,
  EngineOptions,
  IngestResult,
} from './types';
import {
  IdentitySchemaError,
  validateClaimCollisionPayload,
  validateConnectorFact,
  validateDerivedFromProvenance,
  validateFactEventMetadata,
} from './validate';

type Sql = ReturnType<typeof getDb>;

interface IngestParams {
  /** Tenant org these facts are scoped to (where the user's $member lives). */
  tenantOrganizationId: string;
  /** $member entity id in the tenant org for the authenticated user. */
  memberEntityId: number;
  /** Caller user id, used as `created_by` on event rows. */
  userId: string;
  /** Connector account that produced this batch (events.connector_key). */
  connectorKey: string;
  /** Optional connection id for connector-account provenance. */
  connectionId?: number | null;
  /** Set of facts the connector emitted right now. */
  facts: ConnectorFactInput[];
  /** Per-call shadow override; otherwise read from env. */
  options?: EngineOptions;
}

interface RuleRow {
  relationshipTypeId: number;
  relationshipTypeSlug: string;
  catalogOrganizationId: string;
  rules: AutoCreateWhenRule[];
  ruleVersion: number;
  ruleHash: string;
}

interface PriorFact {
  eventId: number;
  namespace: string;
  normalizedValue: string;
  sourceAccountId: string;
  assurance: AssuranceLevelValue;
}

const log = logger.child({ module: 'identity-engine' });

function isShadow(opts: EngineOptions | undefined): boolean {
  if (typeof opts?.shadow === 'boolean') return opts.shadow;
  return process.env.IDENTITY_ENGINE_SHADOW === 'true';
}

function originIdForFact(fact: ConnectorFactInput): string {
  return `identity_fact:${fact.sourceAccountId}:${fact.namespace}`;
}

function canonicaliseRules(rules: AutoCreateWhenRule[]): string {
  return JSON.stringify(
    rules
      .map((r) => ({
        sourceNamespace: r.sourceNamespace,
        targetField: r.targetField,
        assuranceRequired: r.assuranceRequired,
        matchStrategy: r.matchStrategy,
      }))
      .sort((a, b) =>
        a.sourceNamespace === b.sourceNamespace
          ? a.targetField.localeCompare(b.targetField)
          : a.sourceNamespace.localeCompare(b.sourceNamespace)
      )
  );
}

export function ruleHashFor(rules: AutoCreateWhenRule[]): string {
  return createHash('sha256').update(canonicaliseRules(rules)).digest('hex');
}

/**
 * Public-catalog relationship types that declare auto_create_when rules.
 * Read once per ingest pass; small N (one row per relationship type that
 * opts into the engine).
 */
async function loadRules(sql: Sql): Promise<RuleRow[]> {
  const rows = await sql<{
    id: number;
    slug: string;
    organization_id: string;
    metadata: unknown;
  }>`
    SELECT rt.id, rt.slug, rt.organization_id, rt.metadata
    FROM entity_relationship_types rt
    JOIN organization o ON o.id = rt.organization_id
    WHERE rt.deleted_at IS NULL
      AND rt.status = 'active'
      AND o.visibility = 'public'
      AND rt.metadata ? 'autoCreateWhen'
  `;
  const out: RuleRow[] = [];
  for (const row of rows) {
    const meta = row.metadata as
      | { autoCreateWhen?: unknown; ruleVersion?: unknown; ruleHash?: unknown }
      | null
      | undefined;
    if (!meta || !Array.isArray(meta.autoCreateWhen)) continue;
    if (typeof meta.ruleVersion !== 'number' || typeof meta.ruleHash !== 'string') {
      log.warn(
        { relationshipTypeId: row.id },
        'identity-engine: relationship type metadata.autoCreateWhen present without rule_version/rule_hash; skipping'
      );
      continue;
    }
    out.push({
      relationshipTypeId: row.id,
      relationshipTypeSlug: row.slug,
      catalogOrganizationId: row.organization_id,
      rules: meta.autoCreateWhen as AutoCreateWhenRule[],
      ruleVersion: meta.ruleVersion,
      ruleHash: meta.ruleHash,
    });
  }
  return out;
}

async function loadPriorFacts(sql: Sql, sourceAccountId: string): Promise<PriorFact[]> {
  const rows = await sql<{
    id: number;
    metadata: { namespace?: string; normalizedValue?: string; assurance?: string };
  }>`
    SELECT e.id, e.metadata
    FROM current_event_records e
    WHERE e.semantic_type = ${IDENTITY_FACT_SEMANTIC_TYPE}
      AND e.metadata->>'sourceAccountId' = ${sourceAccountId}
  `;
  return rows.map((r) => ({
    eventId: Number(r.id),
    namespace: String(r.metadata?.namespace ?? ''),
    normalizedValue: String(r.metadata?.normalizedValue ?? ''),
    sourceAccountId,
    assurance: (r.metadata?.assurance ?? 'self_attested') as AssuranceLevelValue,
  }));
}

interface MatchedEntity {
  entityId: number;
  organizationId: string;
}

async function findEntitiesByMetadataField(
  sql: Sql,
  catalogOrgId: string,
  field: string,
  normalizedValue: string
): Promise<MatchedEntity[]> {
  const rows = await sql<{ id: number; organization_id: string }>`
    SELECT e.id, e.organization_id
    FROM entities e
    WHERE e.organization_id = ${catalogOrgId}
      AND e.deleted_at IS NULL
      AND e.metadata->>${field} = ${normalizedValue}
  `;
  return rows.map((r) => ({ entityId: Number(r.id), organizationId: r.organization_id }));
}

async function findExistingRelationship(
  sql: Sql,
  fromEntityId: number,
  toEntityId: number,
  relationshipTypeId: number
): Promise<number | null> {
  const rows = await sql<{ id: number }>`
    SELECT id FROM entity_relationships
    WHERE from_entity_id = ${fromEntityId}
      AND to_entity_id = ${toEntityId}
      AND relationship_type_id = ${relationshipTypeId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0 ? Number(rows[0].id) : null;
}

async function insertDerivation(
  sql: Sql,
  fromEntityId: number,
  toEntityId: number,
  relationshipTypeId: number,
  organizationId: string,
  userId: string,
  provenance: DerivedFromProvenance
): Promise<number> {
  validateDerivedFromProvenance(provenance);
  const metadata = { derivedFrom: provenance };
  const rows = await sql<{ id: number }>`
    INSERT INTO entity_relationships (
      from_entity_id, to_entity_id, relationship_type_id, organization_id,
      metadata, created_by, updated_by
    ) VALUES (
      ${fromEntityId}, ${toEntityId}, ${relationshipTypeId}, ${organizationId},
      ${sql.json(metadata)}, ${userId}, ${userId}
    )
    RETURNING id
  `;
  return Number(rows[0].id);
}

async function revokeDerivationsForEvent(
  sql: Sql,
  eventId: number,
  userId: string
): Promise<number[]> {
  const rows = await sql<{ id: number }>`
    UPDATE entity_relationships
    SET deleted_at = NOW(),
        updated_at = NOW(),
        updated_by = ${userId}
    WHERE deleted_at IS NULL
      AND metadata ? 'derivedFrom'
      AND metadata->'derivedFrom'->>'sourceEventId' = ${String(eventId)}
    RETURNING id
  `;
  return rows.map((r) => Number(r.id));
}

async function recordCollision(
  tenantOrgId: string,
  factEventId: number,
  candidateMemberIds: number[],
  fact: ConnectorFactInput,
  relationshipTypeId: number,
  userId: string
): Promise<number | null> {
  const payload = {
    kind: 'identity_match' as const,
    namespace: fact.namespace,
    identifier: fact.identifier,
    normalizedValue: fact.normalizedValue,
    candidateMemberIds,
    triggeringEventId: factEventId,
    relationshipTypeId,
  };
  validateClaimCollisionPayload(payload);
  const ev = await insertEvent({
    organizationId: tenantOrgId,
    entityIds: candidateMemberIds,
    originId: `claim_collision:${fact.sourceAccountId}:${fact.namespace}:${fact.normalizedValue}`,
    semanticType: CLAIM_COLLISION_SEMANTIC_TYPE,
    interactionType: 'approval',
    interactionStatus: 'pending',
    metadata: payload,
    title: `Identity match collision on ${fact.namespace}`,
    payloadType: 'text',
    content: `Two or more candidate $member rows match this provider-verified ${fact.namespace}; manual resolution required.`,
    createdBy: userId,
  });
  return ev?.id ?? null;
}

/**
 * Main entry: ingest a fresh batch of facts for one connector account.
 * Idempotent — safe to call repeatedly with the same input; superseded
 * events stay in history.
 */
export async function ingestFacts(params: IngestParams): Promise<IngestResult> {
  const { tenantOrganizationId, memberEntityId, userId, connectorKey, connectionId, facts } =
    params;
  const shadow = isShadow(params.options);
  const sql = getDb();

  // 1. Validate every fact up front. We do not partially ingest; all-or-nothing.
  for (const fact of facts) {
    try {
      validateConnectorFact(fact);
    } catch (err) {
      if (err instanceof IdentitySchemaError) {
        log.error(
          { err, namespace: fact?.namespace, connectorKey },
          'identity-engine: rejecting batch due to invalid fact'
        );
      }
      throw err;
    }
  }

  const result: IngestResult = {
    factEventIds: [],
    supersededEventIds: [],
    derivedRelationshipIds: [],
    revokedRelationshipIds: [],
    collisionEventIds: [],
    skippedRules: [],
  };

  if (facts.length === 0) return result;

  // Group prior facts by (account, namespace) for diff against incoming.
  const sourceAccountId = facts[0].sourceAccountId;
  if (facts.some((f) => f.sourceAccountId !== sourceAccountId)) {
    throw new Error(
      'identity-engine: ingestFacts requires every fact in a batch to share sourceAccountId'
    );
  }
  const priorFacts = await loadPriorFacts(sql, sourceAccountId);
  const priorByNamespace = new Map<string, PriorFact[]>();
  for (const pf of priorFacts) {
    const list = priorByNamespace.get(pf.namespace) ?? [];
    list.push(pf);
    priorByNamespace.set(pf.namespace, list);
  }

  // 2. Persist each incoming fact, superseding the prior one when the
  // (namespace, sourceAccountId) tuple already had a current event.
  const factEventByNamespace = new Map<string, { eventId: number; fact: ConnectorFactInput }>();
  for (const fact of facts) {
    const factMetadata = {
      namespace: fact.namespace,
      identifier: fact.identifier,
      normalizedValue: fact.normalizedValue,
      assurance: fact.assurance,
      providerStableId: fact.providerStableId,
      sourceAccountId: fact.sourceAccountId,
      validTo: fact.validTo,
      notes: fact.notes,
    };
    validateFactEventMetadata(factMetadata);

    const priorList = priorByNamespace.get(fact.namespace) ?? [];
    // Prior fact MUST be of the same namespace AND same value for this to
    // be a no-op refresh; if value differs, we still supersede the prior so
    // the (account, namespace) latest row reflects the current truth.
    const supersedes = priorList.length > 0 ? priorList[0].eventId : null;

    const inserted = await insertEvent({
      organizationId: tenantOrganizationId,
      entityIds: [memberEntityId],
      originId: originIdForFact(fact),
      semanticType: IDENTITY_FACT_SEMANTIC_TYPE,
      payloadType: 'empty',
      metadata: factMetadata,
      connectorKey,
      connectionId: connectionId ?? null,
      supersedesEventId: supersedes,
      occurredAt: new Date(),
      createdBy: userId,
    });
    if (!inserted) {
      log.warn({ namespace: fact.namespace, sourceAccountId }, 'identity-engine: insertEvent returned null; skipping fact');
      continue;
    }
    result.factEventIds.push(inserted.id);
    factEventByNamespace.set(fact.namespace, { eventId: inserted.id, fact });
    if (supersedes !== null) {
      result.supersededEventIds.push(supersedes);
    }
  }

  // 3. Diff prior facts vs current — anything in prior but not in current
  // (this batch's namespaces) means the connector stopped emitting it.
  // Mark a synthetic supersede so derivation reverse-lookup catches it.
  const incomingNamespaces = new Set(facts.map((f) => f.namespace));
  for (const [namespace, priorList] of priorByNamespace.entries()) {
    if (incomingNamespaces.has(namespace)) continue;
    for (const pf of priorList) {
      // Write a tombstone fact event with no normalizedValue and supersede
      // the prior — preserves audit history and triggers revocation below.
      const tombstoneMeta = {
        namespace,
        identifier: '',
        normalizedValue: '',
        assurance: 'self_attested' as const,
        providerStableId: '',
        sourceAccountId,
        notes: 'superseded by absence on connector refresh',
      };
      validateFactEventMetadata(tombstoneMeta);
      const tombstone = await insertEvent({
        organizationId: tenantOrganizationId,
        entityIds: [memberEntityId],
        originId: `identity_fact_tombstone:${sourceAccountId}:${namespace}`,
        semanticType: IDENTITY_FACT_SEMANTIC_TYPE,
        payloadType: 'empty',
        metadata: tombstoneMeta,
        connectorKey,
        connectionId: connectionId ?? null,
        supersedesEventId: pf.eventId,
        occurredAt: new Date(),
        createdBy: userId,
      });
      if (tombstone) {
        result.factEventIds.push(tombstone.id);
        result.supersededEventIds.push(pf.eventId);
      }
    }
  }

  if (shadow) {
    log.info(
      { factCount: facts.length, factEventIds: result.factEventIds.length, sourceAccountId },
      'identity-engine: shadow mode — skipped derivation/revocation pass'
    );
    return result;
  }

  // 4. Revoke derivations referencing any superseded fact event.
  for (const supersededId of result.supersededEventIds) {
    const revoked = await revokeDerivationsForEvent(sql, supersededId, userId);
    if (revoked.length > 0) {
      result.revokedRelationshipIds.push(...revoked);
      log.info(
        { supersededEventId: supersededId, revokedCount: revoked.length },
        'identity-engine: revoked derivations for superseded fact'
      );
    }
  }

  // 5. Apply auto_create_when rules against each just-written fact.
  const rules = await loadRules(sql);
  for (const fact of facts) {
    const ev = factEventByNamespace.get(fact.namespace);
    if (!ev) continue;
    for (const ruleSet of rules) {
      for (const rule of ruleSet.rules) {
        if (rule.sourceNamespace !== fact.namespace) continue;
        if (!assuranceMeets(fact.assurance, rule.assuranceRequired)) {
          result.skippedRules.push({
            ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
            reason: `assurance ${fact.assurance} below required ${rule.assuranceRequired}`,
          });
          continue;
        }

        const matches = await findEntitiesByMetadataField(
          sql,
          ruleSet.catalogOrganizationId,
          rule.targetField,
          fact.normalizedValue
        );

        if (matches.length === 0) continue;

        if (matches.length > 1 && rule.matchStrategy === 'unique_only') {
          // Surface as a collision event for admin / user resolution.
          const collisionId = await recordCollision(
            tenantOrganizationId,
            ev.eventId,
            matches.map((m) => m.entityId),
            fact,
            ruleSet.relationshipTypeId,
            userId
          );
          if (collisionId !== null) result.collisionEventIds.push(collisionId);
          result.skippedRules.push({
            ruleId: `${ruleSet.relationshipTypeSlug}@${ruleSet.ruleVersion}`,
            reason: `${matches.length} matches with match_strategy=unique_only`,
          });
          continue;
        }

        if (rule.matchStrategy === 'first_match') {
          // first_match is not allowed in v1 for safety; reject loudly.
          throw new Error(
            `identity-engine: match_strategy='first_match' is not allowed in v1 (rule on relationship_type ${ruleSet.relationshipTypeSlug})`
          );
        }

        // unique_only with one match, or all_matches with N → derive each.
        const targets = rule.matchStrategy === 'unique_only' ? [matches[0]] : matches;
        for (const target of targets) {
          const existing = await findExistingRelationship(
            sql,
            memberEntityId,
            target.entityId,
            ruleSet.relationshipTypeId
          );
          if (existing !== null) {
            // Already derived — idempotent skip.
            continue;
          }
          const provenance: DerivedFromProvenance = {
            sourceEventId: ev.eventId,
            relationshipTypeId: ruleSet.relationshipTypeId,
            ruleVersion: ruleSet.ruleVersion,
            ruleHash: ruleSet.ruleHash,
            factAssurance: fact.assurance,
            derivedAt: new Date().toISOString(),
          };
          const relId = await insertDerivation(
            sql,
            memberEntityId,
            target.entityId,
            ruleSet.relationshipTypeId,
            target.organizationId,
            userId,
            provenance
          );
          result.derivedRelationshipIds.push(relId);
        }
      }
    }
  }

  log.info(
    {
      sourceAccountId,
      facts: result.factEventIds.length,
      superseded: result.supersededEventIds.length,
      derived: result.derivedRelationshipIds.length,
      revoked: result.revokedRelationshipIds.length,
      collisions: result.collisionEventIds.length,
      skipped: result.skippedRules.length,
    },
    'identity-engine: ingest complete'
  );
  return result;
}
