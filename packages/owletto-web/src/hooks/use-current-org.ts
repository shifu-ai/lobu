import { useMemo } from 'react';
import { type Organization, useOrganizations } from '@/lib/api';
import { useOrgContext } from './use-org-context';

export interface UseCurrentOrgResult {
  org: Organization | null;
  isMember: boolean;
  isPublic: boolean;
  isLoading: boolean;
}

/**
 * Resolves the Organization record for the org currently in the URL (via
 * useOrgContext) against the list returned by `/api/organizations`. The
 * response includes both the caller's member orgs and any public orgs, so
 * callers can distinguish "I'm browsing a public workspace as a non-member"
 * from "I'm actually a member here".
 */
export function useCurrentOrg(): UseCurrentOrgResult {
  const { urlOrgSlug } = useOrgContext();
  const { data: orgs, isLoading } = useOrganizations();

  const org = useMemo(() => {
    if (!urlOrgSlug || !orgs) return null;
    return orgs.find((o) => o.slug === urlOrgSlug) ?? null;
  }, [orgs, urlOrgSlug]);

  return {
    org,
    isMember: !!org?.is_member,
    isPublic: org?.visibility === 'public',
    isLoading,
  };
}
