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
import { ingestFacts } from './engine';
import { getVerifiedFactsFromGoogle } from './connectors/google';
import type { ConnectorFact } from '@lobu/owletto-sdk';

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
  const rows = await sql<{ organization_id: string; entity_id: number }>`
    SELECT m."organizationId" AS organization_id, e.id AS entity_id
    FROM "member" m
    JOIN organization o ON o.id = m."organizationId"
    JOIN entity_identities ei
      ON ei.organization_id = m."organizationId"
     AND ei.namespace = 'auth_user_id'
     AND ei.identifier = ${userId}
     AND ei.deleted_at IS NULL
    JOIN entities e ON e.id = ei.entity_id AND e.deleted_at IS NULL
    JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = '$member'
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

async function emitFactsForProvider(account: AuthAccountSummary): Promise<ConnectorFact[]> {
  if (!account.accessToken) return [];
  switch (account.providerId) {
    case 'google':
      return getVerifiedFactsFromGoogle({
        accessToken: account.accessToken,
        sourceAccountId: account.id,
      });
    // Future providers register here. Each emitter declares its own
    // ConnectorIdentityCapability so a future CI lint can verify the
    // emitted namespaces match the declaration.
    default:
      return [];
  }
}

/**
 * Schedule the identity-engine ingest for a freshly-created or refreshed
 * social-login account. Fire-and-forget. Errors are logged, not thrown.
 */
export function scheduleIdentityIngest(account: AuthAccountSummary): void {
  void (async () => {
    try {
      const facts = await emitFactsForProvider(account);
      if (facts.length === 0) return;

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
        connectorKey: account.providerId,
        facts,
      });
    } catch (err) {
      log.error(
        { err, userId: account.userId, providerId: account.providerId },
        'identity-engine: ingest failed'
      );
    }
  })();
}
