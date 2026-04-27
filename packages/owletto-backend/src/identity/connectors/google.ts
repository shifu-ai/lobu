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

const log = logger.child({ module: 'identity-connector-google' });

export const googleIdentityCapability: ConnectorIdentityCapability = {
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
 * Fetch Google's userinfo payload and translate into ConnectorFacts. Returns
 * an empty array when the call fails or the payload is missing required
 * fields — engine treats an empty batch as "no facts to derive against",
 * which is the right behavior (silently no-ops, doesn't break sign-in).
 */
export async function getVerifiedFactsFromGoogle(
  params: GoogleEmitterParams
): Promise<ConnectorFact[]> {
  if (!params.accessToken) return [];

  let payload: Awaited<ReturnType<typeof fetchUserInfoWithRaw>>;
  try {
    payload = await fetchUserInfoWithRaw({
      provider: 'google',
      accessToken: params.accessToken,
    });
  } catch (err) {
    log.warn({ err, sourceAccountId: params.sourceAccountId }, 'google userinfo fetch failed');
    return [];
  }

  if (!payload.raw) return [];
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
    return [];
  }

  const facts: ConnectorFact[] = [];

  // Email — emitted only when verified by Google.
  if (typeof raw.email === 'string' && raw.email_verified !== false) {
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

  return facts;
}
