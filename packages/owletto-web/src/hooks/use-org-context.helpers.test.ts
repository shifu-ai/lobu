import { describe, expect, it } from 'vitest';
import { resolveOrgContext } from './use-org-context.helpers';

describe('resolveOrgContext', () => {
  it('prefers the URL org for authenticated users while auth state points elsewhere', () => {
    expect(
      resolveOrgContext({
        isAuthenticated: true,
        activeOrgId: 'org-active',
        activeOrgSlug: 'personal',
        urlOrgSlug: 'buremba',
        personalOrgSlug: 'burak',
        firstUserOrgSlug: 'personal',
      })
    ).toEqual({
      resolvedOrgSlug: 'buremba',
      resolvedOrganizationId: null,
      currentOwner: 'buremba',
      hasOrgContext: true,
    });
  });

  it('uses the active organization when there is no URL org', () => {
    expect(
      resolveOrgContext({
        isAuthenticated: true,
        activeOrgId: 'org-active',
        activeOrgSlug: 'acme',
        urlOrgSlug: null,
        personalOrgSlug: 'burak',
        firstUserOrgSlug: 'acme',
      })
    ).toEqual({
      resolvedOrgSlug: 'acme',
      resolvedOrganizationId: 'org-active',
      currentOwner: 'acme',
      hasOrgContext: true,
    });
  });

  it('falls back to personal org when no URL org and no active org', () => {
    expect(
      resolveOrgContext({
        isAuthenticated: true,
        activeOrgId: null,
        activeOrgSlug: null,
        urlOrgSlug: null,
        personalOrgSlug: 'burak',
        firstUserOrgSlug: 'acme',
      })
    ).toEqual({
      resolvedOrgSlug: null,
      resolvedOrganizationId: null,
      currentOwner: 'burak',
      hasOrgContext: false,
    });
  });

  it('uses the URL org for unauthenticated users', () => {
    expect(
      resolveOrgContext({
        isAuthenticated: false,
        activeOrgId: null,
        activeOrgSlug: null,
        urlOrgSlug: 'public-org',
        personalOrgSlug: null,
        firstUserOrgSlug: null,
      })
    ).toEqual({
      resolvedOrgSlug: 'public-org',
      resolvedOrganizationId: null,
      currentOwner: 'public-org',
      hasOrgContext: true,
    });
  });
});
