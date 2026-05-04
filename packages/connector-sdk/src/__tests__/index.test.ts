import { describe, expect, test } from 'bun:test';
import * as sdk from '../index.js';

describe('connector-sdk index re-exports', () => {
  test('re-exports core runtime classes', () => {
    expect(typeof sdk.ConnectorRuntime).toBe('function');
    expect(typeof sdk.BaseFeed).toBe('function');
    expect(typeof sdk.RateLimitError).toBe('function');
    expect(typeof sdk.PaginatedFeed).toBe('function');
    expect(typeof sdk.ApiPaginatedFeed).toBe('function');
  });

  test('re-exports HTTP helpers', () => {
    expect(typeof sdk.createAuthenticatedClient).toBe('function');
    expect(typeof sdk.createHttpClient).toBe('function');
    expect(sdk.httpClient).toBeDefined();
    expect(sdk.jsonHttpClient).toBeDefined();
  });

  test('re-exports identity normalizers', () => {
    expect(typeof sdk.normalizeAuthUserId).toBe('function');
    expect(typeof sdk.normalizeEmail).toBe('function');
    expect(typeof sdk.normalizeGithubLogin).toBe('function');
    expect(typeof sdk.normalizeGoogleContactId).toBe('function');
    expect(typeof sdk.normalizeIdentifier).toBe('function');
    expect(typeof sdk.normalizePhone).toBe('function');
    expect(typeof sdk.normalizeSlackUserId).toBe('function');
    expect(typeof sdk.normalizeWaJid).toBe('function');
  });

  test('re-exports IDENTITY namespace constants', () => {
    expect(sdk.IDENTITY).toBeDefined();
    expect(sdk.IDENTITY.PHONE).toBe('phone');
    expect(sdk.IDENTITY.EMAIL).toBe('email');
    expect(sdk.IDENTITY.SLACK_USER_ID).toBe('slack_user_id');
    expect(sdk.IDENTITY.GITHUB_LOGIN).toBe('github_login');
    expect(sdk.IDENTITY.WA_JID).toBe('wa_jid');
    expect(sdk.IDENTITY.AUTH_USER_ID).toBe('auth_user_id');
    expect(sdk.IDENTITY.GOOGLE_CONTACT_ID).toBe('google_contact_id');
  });

  test('re-exports event taxonomy helpers', () => {
    expect(typeof sdk.isSourceNativeEventType).toBe('function');
    expect(sdk.SOURCE_NATIVE_EVENT_TYPES).toBeDefined();
  });

  test('re-exports retry, scoring, and watcher-time helpers', () => {
    expect(typeof sdk.withHttpRetry).toBe('function');
    expect(typeof sdk.calculateEngagementScore).toBe('function');
    expect(typeof sdk.addWatcherPeriod).toBe('function');
    expect(typeof sdk.alignToWatcherWindowStart).toBe('function');
    expect(typeof sdk.subtractWatcherPeriod).toBe('function');
    expect(typeof sdk.shiftWatcherPeriod).toBe('function');
    expect(typeof sdk.isWatcherTimeGranularity).toBe('function');
    expect(typeof sdk.inferWatcherGranularityFromDays).toBe('function');
    expect(typeof sdk.inferWatcherGranularityFromSchedule).toBe('function');
    expect(typeof sdk.getAvailableWatcherGranularities).toBe('function');
    expect(typeof sdk.getFinerWatcherGranularities).toBe('function');
    expect(typeof sdk.getNextWatcherGranularity).toBe('function');
    expect(typeof sdk.getWatcherDateTruncUnit).toBe('function');
    expect(Array.isArray(sdk.WATCHER_TIME_GRANULARITIES)).toBe(true);
  });

  test('re-exports identity-types schema/value helpers', () => {
    // These are TypeBox values (also typed) — schema objects should be defined.
    expect(sdk.AssuranceLevel).toBeDefined();
    expect(typeof sdk.assuranceMeets).toBe('function');
    expect(sdk.AutoCreateWhenRule).toBeDefined();
    expect(sdk.MatchStrategy).toBeDefined();
    expect(typeof sdk.CLAIM_COLLISION_SEMANTIC_TYPE).toBe('string');
    expect(typeof sdk.IDENTITY_FACT_SEMANTIC_TYPE).toBe('string');
    expect(sdk.ClaimCollisionPayload).toBeDefined();
    expect(sdk.ConnectorFact).toBeDefined();
    expect(sdk.ConnectorIdentityCapability).toBeDefined();
    expect(sdk.DerivedFromProvenance).toBeDefined();
    expect(sdk.DerivedRelationshipMetadata).toBeDefined();
    expect(sdk.FactEventMetadata).toBeDefined();
    expect(sdk.RelationshipTypeIdentityMetadata).toBeDefined();
  });

  test('re-exports logger', () => {
    expect(sdk.sdkLogger).toBeDefined();
    expect(sdk.logger).toBeDefined();
    expect(sdk.logger).toBe(sdk.sdkLogger);
  });

  test('re-exports TypeBox Type and ky', () => {
    expect(sdk.Type).toBeDefined();
    expect(typeof sdk.Type.Object).toBe('function');
    expect(typeof sdk.ky).toBe('function');
    expect(typeof sdk.HTTPError).toBe('function');
  });
});
