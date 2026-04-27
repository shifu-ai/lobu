/**
 * Bridge between the BetterAuth account hooks and the identity engine.
 *
 * On every social-login `account.create.after` and `account.update.after`,
 * this resolves the user's tenant `$member` and ingests verified facts
 * from the appropriate connector emitter. Fire-and-forget — sign-in must
 * NEVER block on engine work.
 *
 * Provider routing is data: each `providerId` maps to a single emitter
 * here. New providers register a new branch; everything else (rules,
 * matching, derivations) stays generic.
 */

import { getDb } from '../db/client';
import logger from '../utils/logger';
import { connectorCapabilityRegistry } from './capability-registry';
// Side-effect import: each connector module self-registers on load.
import './connectors';
import { ingestFacts } from './engine';

const log = logger.child({ module: 'identity-auth-hook' });

interface AuthAccountSummary {
  id: string;
  userId: string;
  providerId: string;
  accessToken?: string | null;
  scope?: string | null;
}

interface ResolvedTenantMember {
  tenantOrganizationId: string;
  memberEntityId: number;
}

/**
 * Find the user's personal org and `$member` entity id. Returns null when
 * personal-org provisioning hasn't yet completed for this user — ingest
 * will be retried on the next account refresh.
 */
async function resolveTenantMember(userId: string): Promise<ResolvedTenantMember | null> {
  const sql = getDb();
  // Pi P0.1 — restrict to entity_identities written by the auth-server
  // signup hook so user-supplied identity rows can't hijack the lookup, and
  // join on matching organization_id at every level so a stale cross-org
  // row can't redirect the bind to another tenant.
  const rows = await sql<{ organization_id: string; entity_id: number }>`
    SELECT m."organizationId" AS organization_id, e.id AS entity_id
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    JOIN entity_identities ei
      ON ei.organization_id = m."organizationId"
     AND ei.namespace = 'auth_user_id'
     AND ei.identifier = ${userId}
     AND ei.deleted_at IS NULL
     AND ei.source_connector = 'auth:signup'
    JOIN entities e
      ON e.id = ei.entity_id
     AND e.organization_id = ei.organization_id
     AND e.deleted_at IS NULL
    JOIN entity_types et
      ON et.id = e.entity_type_id
     AND et.organization_id = e.organization_id
     AND et.slug = '$member'
    WHERE m."userId" = ${userId}
      AND o.visibility = 'private'
    ORDER BY o."createdAt" ASC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    tenantOrganizationId: String(rows[0].organization_id),
    memberEntityId: Number(rows[0].entity_id),
  };
}

/**
 * Schedule the identity-engine ingest for a freshly-created or refreshed
 * social-login account. Fire-and-forget. Errors are logged, not thrown.
 *
 * Provider routing is registry-based — there is no per-provider branch in
 * core code. Each connector self-registers in `connectors/<name>.ts` and
 * the registry maps `providerId` → emitter.
 */
export function scheduleIdentityIngest(account: AuthAccountSummary): void {
  void (async () => {
    try {
      if (!account.accessToken) return;
      const emit = connectorCapabilityRegistry.emitter(account.providerId);
      if (!emit) {
        log.debug(
          { providerId: account.providerId, userId: account.userId },
          'identity-engine: no connector registered for provider; skipping ingest'
        );
        return;
      }
      const emitted = await emit({
        accessToken: account.accessToken,
        sourceAccountId: account.id,
      });
      // Pi P1.4 — fetch failure: do NOT call ingestFacts (would tombstone
      // everything). emit returning null is the explicit signal.
      if (!emitted) return;

      const resolved = await resolveTenantMember(account.userId);
      if (!resolved) {
        log.debug(
          { userId: account.userId, providerId: account.providerId },
          'identity-engine: no tenant $member yet — skipping ingest'
        );
        return;
      }

      await ingestFacts({
        tenantOrganizationId: resolved.tenantOrganizationId,
        memberEntityId: resolved.memberEntityId,
        userId: account.userId,
        accountIdentity: {
          connectorKey: account.providerId,
          providerStableId: emitted.providerStableId,
          sourceAccountId: account.id,
        },
        facts: emitted.facts,
      });
    } catch (err) {
      log.error(
        { err, userId: account.userId, providerId: account.providerId },
        'identity-engine: ingest failed'
      );
    }
  })();
}
