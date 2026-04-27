/**
 * Google verified-facts emitter.
 *
 * Reads the Google `userinfo` payload for an authenticated account and
 * emits `ConnectorFact[]` with appropriate assurance. The platform layer
 * passes the result to `engine.ingestFacts`.
 *
 * Capability declaration is published statically so a future CI lint can
 * assert that this file never emits a namespace it didn't declare.
 */

import type { ConnectorFact, ConnectorIdentityCapability } from '@lobu/owletto-sdk';
import { normalizeEmail } from '@lobu/owletto-sdk';
import { fetchUserInfoWithRaw } from '../../connect/oauth-providers';
import logger from '../../utils/logger';
import { registerConnector } from '../capability-registry';

const log = logger.child({ module: 'identity-connector-google' });

const googleIdentityCapability: ConnectorIdentityCapability = {
  connectorKey: 'google',
  produces: [
    {
      namespace: 'email',
      assurance: 'oauth_verified',
      notes: "Google's verified primary email; survives provider-level account changes via providerStableId.",
    },
    {
      namespace: 'hosted_domain',
      assurance: 'oauth_verified',
      notes:
        'Google Workspace `hd` claim. Present only for Workspace accounts; absent for personal Gmail.',
    },
  ],
};

interface GoogleEmitterParams {
  /** OAuth access token for the user's Google account. */
  accessToken: string;
  /** Better-Auth account row id; used as `sourceAccountId` on every fact. */
  sourceAccountId: string;
}

/**
 * Successful emit. `facts` may be empty when the user's Google account is
 * legitimately producing no relevant attributes (rare). The engine treats
 * an empty result authoritatively: prior facts get tombstoned. Pi P1.4.
 */
export interface GoogleEmitResult {
  providerStableId: string;
  facts: ConnectorFact[];
}

/**
 * Fetch Google's userinfo payload and translate into ConnectorFacts.
 *
 * Returns `null` when the fetch FAILS (network error, no payload, missing
 * provider stable id) — caller MUST NOT call `ingestFacts` on null.
 * Returns `{ providerStableId, facts }` on success (facts may be empty if
 * the account legitimately has no relevant verified attributes).
 */
export async function getVerifiedFactsFromGoogle(
  params: GoogleEmitterParams
): Promise<GoogleEmitResult | null> {
  if (!params.accessToken) return null;

  let payload: Awaited<ReturnType<typeof fetchUserInfoWithRaw>>;
  try {
    payload = await fetchUserInfoWithRaw({
      provider: 'google',
      accessToken: params.accessToken,
    });
  } catch (err) {
    log.warn({ err, sourceAccountId: params.sourceAccountId }, 'google userinfo fetch failed');
    return null;
  }

  if (!payload.raw) return null;
  const raw = payload.raw as {
    sub?: unknown;
    id?: unknown;
    email?: unknown;
    email_verified?: unknown;
    hd?: unknown;
  };

  const providerStableId = String(raw.sub ?? raw.id ?? '');
  if (!providerStableId) {
    log.warn({ sourceAccountId: params.sourceAccountId }, 'google userinfo missing sub/id');
    return null;
  }

  const facts: ConnectorFact[] = [];

  // Email — emitted only when explicitly verified by Google.
  // Pi P1.9 — `!== false` accepts missing/null/string-typed values; require a
  // boolean-true to upgrade to oauth_verified. Anything else stays out.
  if (typeof raw.email === 'string' && raw.email_verified === true) {
    const normalized = normalizeEmail(raw.email);
    if (normalized) {
      facts.push({
        namespace: 'email',
        identifier: raw.email,
        normalizedValue: normalized,
        assurance: 'oauth_verified',
        providerStableId,
        sourceAccountId: params.sourceAccountId,
      });
    }
  }

  // Hosted domain — Google Workspace only. Absent for personal accounts.
  if (typeof raw.hd === 'string' && raw.hd.length > 0) {
    const normalized = raw.hd.toLowerCase();
    facts.push({
      namespace: 'hosted_domain',
      identifier: raw.hd,
      normalizedValue: normalized,
      assurance: 'oauth_verified',
      providerStableId,
      sourceAccountId: params.sourceAccountId,
    });
  }

  return { providerStableId, facts };
}

// Self-registration. Importing this module is the only thing core code
// has to do to enable the Google connector — there's no `case 'google'`
// branch anywhere in the engine or auth-hook.
registerConnector({
  capability: googleIdentityCapability,
  emit: getVerifiedFactsFromGoogle,
});
