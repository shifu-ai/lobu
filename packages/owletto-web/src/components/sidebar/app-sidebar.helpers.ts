import { parseEntityTabSegment } from '@/components/entity-tabs/types';
import type { Organization } from '@/lib/api';
import { normalizePath } from '@/lib/url';

interface SidebarSessionUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface SidebarActiveOrg {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  logo?: string | null;
}

export interface SidebarOrgDisplayState {
  displayName: string;
  displayLogo?: string;
  displayInitial: string;
  activeSlug: string | null;
}

export function pathsMatch(currentPath: string, targetPath: string): boolean {
  return normalizePath(currentPath) === normalizePath(targetPath);
}

export function isSectionPathActive(params: {
  locationPathname: string;
  sectionPath: string;
}): boolean {
  const current = normalizePath(params.locationPathname);
  const target = normalizePath(params.sectionPath);

  return current === target || current.startsWith(`${target}/`);
}

export function isDashboardPathActive(params: {
  locationPathname: string;
  dashboardPath: string;
  currentOwner: string | null;
}): boolean {
  if (pathsMatch(params.locationPathname, params.dashboardPath)) {
    return true;
  }

  return params.currentOwner
    ? pathsMatch(params.locationPathname, `/${params.currentOwner}`)
    : false;
}

export function deriveSidebarResolvePath(params: {
  currentOwner: string | null;
  locationPathname: string;
}): string | null {
  if (!params.currentOwner) return null;

  const ownerRoot = normalizePath(`/${params.currentOwner}`);
  const currentPath = normalizePath(params.locationPathname);
  const suffix = currentPath.startsWith(ownerRoot) ? currentPath.slice(ownerRoot.length) : '';
  const segments = suffix.replace(/^\/+/, '').split('/').filter(Boolean);

  if (segments.length === 0) {
    return ownerRoot;
  }

  if (segments[0] === 'members' || segments[0] === 'agents') {
    return ownerRoot;
  }

  const entitySegments = [...segments];
  const lastSegment = entitySegments[entitySegments.length - 1];
  const secondToLastSegment =
    entitySegments.length >= 2 ? entitySegments[entitySegments.length - 2] : undefined;

  if (parseEntityTabSegment(lastSegment)) {
    entitySegments.pop();
  }

  if (
    entitySegments.length >= 2 &&
    (secondToLastSegment === 'watchers' ||
      parseEntityTabSegment(secondToLastSegment) === 'connectors') &&
    !parseEntityTabSegment(lastSegment)
  ) {
    entitySegments.splice(-2);
  }

  if (entitySegments.length % 2 !== 0) {
    entitySegments.pop();
  }

  return entitySegments.length > 0 ? `${ownerRoot}/${entitySegments.join('/')}` : ownerRoot;
}

export function resolveOrganizationDisplay(params: {
  isAuthenticated: boolean;
  urlOrgSlug: string | null;
  activeOrg?: SidebarActiveOrg | null;
  sessionUser?: SidebarSessionUser | null;
  organizations: Organization[];
}): SidebarOrgDisplayState {
  const matchedUrlOrg = params.urlOrgSlug
    ? params.organizations.find((org) => org.slug === params.urlOrgSlug)
    : null;

  if (params.isAuthenticated) {
    if (params.urlOrgSlug) {
      const displayName = matchedUrlOrg?.name || params.urlOrgSlug;
      return {
        displayName,
        displayLogo: matchedUrlOrg?.logo || undefined,
        displayInitial: displayName[0] || 'W',
        activeSlug: params.urlOrgSlug,
      };
    }

    const displayName = params.activeOrg?.name || params.sessionUser?.name || 'Personal';
    return {
      displayName,
      displayLogo: params.activeOrg?.logo || params.sessionUser?.image || undefined,
      displayInitial:
        params.activeOrg?.name?.[0] ||
        params.sessionUser?.name?.[0] ||
        params.sessionUser?.email?.[0] ||
        'P',
      activeSlug: params.activeOrg?.slug || null,
    };
  }

  const publicOrg = matchedUrlOrg || params.organizations[0];
  const displayName = publicOrg?.name || params.urlOrgSlug || 'Select Organization';
  return {
    displayName,
    displayLogo: publicOrg?.logo || undefined,
    displayInitial: displayName[0] || 'W',
    activeSlug: params.urlOrgSlug || publicOrg?.slug || null,
  };
}

export function isOrganizationActive(params: {
  organization: Organization;
  urlOrgSlug: string | null;
  activeOrg?: SidebarActiveOrg | null;
}): boolean {
  if (params.urlOrgSlug) {
    return params.organization.slug === params.urlOrgSlug;
  }

  return (
    params.organization.id === params.activeOrg?.id ||
    params.organization.slug === params.activeOrg?.slug
  );
}
