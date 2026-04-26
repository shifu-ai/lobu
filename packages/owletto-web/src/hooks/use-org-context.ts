/**
 * Consolidated hook for organization/user context
 *
 * Provides:
 * - Current user's username and @-prefixed owner string
 * - Organization context for API calls (organizationId or slug)
 * - URL owner detection from pathname
 */

import { useLocation } from '@tanstack/react-router';
import type { Organization as AuthOrganization, Session } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { getSubdomainOwner } from '@/lib/subdomain';
import { getOwnerFromPath, parseOwner } from '@/lib/url';
import { resolveOrgContext } from './use-org-context.helpers';

export interface OrgContext {
  organizationId?: string;
  slug?: string;
}

export interface UseOrgContextResult {
  // Session info
  session: Session | null;
  isAuthenticated: boolean;
  authReady: boolean;

  // Personal org slug (user's username)
  personalOrgSlug: string | null;

  // Active org
  activeOrg: AuthOrganization | null;
  activeOrgSlug: string | null;
  resolvedOrgSlug: string | null;
  resolvedOrganizationId: string | null;

  // URL-derived info
  urlOwner: string | null; // raw from URL (could be @user or org-slug)
  urlOrgSlug: string | null; // org slug only (null if @user URL)
  isUrlUserSpace: boolean;

  // Current context for display/navigation
  currentOwner: string | null; // what to use in URLs

  // API context - use this for API calls
  orgContext: OrgContext;
  hasOrgContext: boolean;

  // All orgs the current user belongs to (empty when unauthenticated)
  allOrgs: Array<{ id: string; name: string; slug: string }>;
}

export function useOrgContext(): UseOrgContextResult {
  const location = useLocation();
  const {
    session,
    activeOrganization: activeOrg,
    organizations: userOrgs,
    isReady,
  } = useAuthState();

  const personalOrgSlug = (session?.user as { username?: string | null })?.username || null;

  // Get active org slug
  const activeOrgSlug = (activeOrg as { slug?: string | null })?.slug || null;

  // Parse URL — subdomain wins over path on `{org}.lobu.ai` hosts.
  const urlOwner = getSubdomainOwner() ?? getOwnerFromPath(location.pathname);
  const urlOwnerInfo = urlOwner ? parseOwner(urlOwner) : null;
  const isUrlUserSpace = urlOwnerInfo?.isUser ?? false;
  const urlOrgSlug = isUrlUserSpace ? null : urlOwner;

  // Fallback: first org the user belongs to
  const firstUserOrgSlug = (userOrgs?.[0] as { slug?: string | null } | undefined)?.slug || null;

  const { resolvedOrgSlug, resolvedOrganizationId, currentOwner, hasOrgContext } =
    resolveOrgContext({
      isAuthenticated: !!session,
      activeOrgId: activeOrg?.id,
      activeOrgSlug,
      urlOrgSlug,
      personalOrgSlug,
      firstUserOrgSlug,
    });

  // API context - what to pass to hooks
  const orgContext: OrgContext = session
    ? {
        organizationId: resolvedOrganizationId || undefined,
        slug: resolvedOrgSlug || undefined,
      }
    : { slug: resolvedOrgSlug || undefined };

  return {
    session,
    isAuthenticated: !!session,
    authReady: isReady,
    personalOrgSlug,
    activeOrg,
    activeOrgSlug,
    resolvedOrgSlug,
    resolvedOrganizationId,
    urlOwner,
    urlOrgSlug,
    isUrlUserSpace,
    currentOwner,
    orgContext,
    hasOrgContext,
    allOrgs: userOrgs,
  };
}
