import { describe, expect, it } from 'vitest';
import type { Organization } from '@/lib/api';
import {
  deriveSidebarResolvePath,
  isDashboardPathActive,
  isSectionPathActive,
  pathsMatch,
  resolveOrganizationDisplay,
} from './app-sidebar.helpers';

const organizations: Organization[] = [
  {
    id: 'member-org',
    name: 'Acme',
    slug: 'acme',
    logo: null,
    description: null,
    created_at: '2026-03-17T00:00:00.000Z',
    is_member: true,
    visibility: 'private',
  },
  {
    id: 'public-org',
    name: 'Buremba',
    slug: 'buremba',
    logo: null,
    description: null,
    created_at: '2026-03-17T00:00:00.000Z',
    is_member: false,
    visibility: 'public',
  },
];

describe('resolveOrganizationDisplay', () => {
  it('shows the URL org immediately for authenticated users', () => {
    expect(
      resolveOrganizationDisplay({
        isAuthenticated: true,
        urlOrgSlug: 'buremba',
        activeOrg: { id: 'member-org', slug: 'acme', name: 'Acme', logo: null },
        sessionUser: { name: 'Burak', email: 'burak@example.com', image: null },
        organizations,
      })
    ).toMatchObject({
      displayName: 'Buremba',
      displayInitial: 'B',
      activeSlug: 'buremba',
    });
  });

  it('falls back to the active org when there is no URL org', () => {
    expect(
      resolveOrganizationDisplay({
        isAuthenticated: true,
        urlOrgSlug: null,
        activeOrg: { id: 'member-org', slug: 'acme', name: 'Acme', logo: null },
        sessionUser: { name: 'Burak', email: 'burak@example.com', image: null },
        organizations,
      })
    ).toMatchObject({
      displayName: 'Acme',
      displayInitial: 'A',
      activeSlug: 'acme',
    });
  });

  it('shows public URL orgs without requiring an active org', () => {
    expect(
      resolveOrganizationDisplay({
        isAuthenticated: false,
        urlOrgSlug: 'buremba',
        activeOrg: null,
        sessionUser: null,
        organizations,
      })
    ).toMatchObject({
      displayName: 'Buremba',
      displayInitial: 'B',
      activeSlug: 'buremba',
    });
  });
});

describe('deriveSidebarResolvePath', () => {
  it('keeps workspace root stable for workspace-level pages', () => {
    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba',
      })
    ).toBe('/buremba');

    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/members',
      })
    ).toBe('/buremba');
  });

  it('strips entity tabs and detail routes to the same entity scope', () => {
    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/brand/acme/watchers',
      })
    ).toBe('/buremba/brand/acme');

    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/brand/acme/watchers/172',
      })
    ).toBe('/buremba/brand/acme');

    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/brand/acme/connectors/reddit',
      })
    ).toBe('/buremba/brand/acme');
  });

  it('preserves nested entity scope while removing tab segments', () => {
    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/brand/acme/product/rocket-skates/watchers/172',
      })
    ).toBe('/buremba/brand/acme/product/rocket-skates');
  });

  it('falls back to the workspace root for incomplete entity paths', () => {
    expect(
      deriveSidebarResolvePath({
        currentOwner: 'buremba',
        locationPathname: '/buremba/brand',
      })
    ).toBe('/buremba');
  });
});

describe('sidebar path matching', () => {
  it('treats dashboard paths with and without trailing slashes as equal', () => {
    expect(pathsMatch('/buremba/getting-started', '/buremba/getting-started/')).toBe(true);
  });

  it('marks dashboard active for both owner and workspace-home routes', () => {
    expect(
      isDashboardPathActive({
        locationPathname: '/buremba/getting-started',
        dashboardPath: '/buremba/getting-started/',
        currentOwner: 'buremba',
      })
    ).toBe(true);

    expect(
      isDashboardPathActive({
        locationPathname: '/buremba/',
        dashboardPath: '/buremba/getting-started',
        currentOwner: 'buremba',
      })
    ).toBe(true);
  });

  it('marks workspace sections active for descendant detail routes', () => {
    expect(
      isSectionPathActive({
        locationPathname: '/buremba/connectors/capterra',
        sectionPath: '/buremba/connectors',
      })
    ).toBe(true);

    expect(
      isSectionPathActive({
        locationPathname: '/buremba/watchers/123',
        sectionPath: '/buremba/watchers',
      })
    ).toBe(true);

    expect(
      isSectionPathActive({
        locationPathname: '/buremba/connectors-and-more',
        sectionPath: '/buremba/connectors',
      })
    ).toBe(false);
  });
});
