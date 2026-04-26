import { useEffect, useMemo, useState } from 'react';
import { useAuthState } from '@/lib/auth-state';

interface OrgEntry {
  id: string;
  name: string;
  slug: string;
}

export function useOrgPreselect(): {
  orgList: OrgEntry[];
  selectedOrgId: string;
  setSelectedOrgId: (id: string) => void;
  orgsLoading: boolean;
} {
  const {
    session,
    activeOrganization: activeOrg,
    organizations: userOrgs,
    organizationListResult,
  } = useAuthState();
  const orgsLoading = organizationListResult.isPending;
  const [selectedOrgId, setSelectedOrgId] = useState('');

  const orgList = useMemo(() => {
    if (!userOrgs) return [];
    return (userOrgs as Array<{ id: string; name: string; slug: string }>).map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
    }));
  }, [userOrgs]);

  useEffect(() => {
    if (selectedOrgId || orgsLoading || !userOrgs) return;
    const list = userOrgs as Array<{ id: string; name: string; slug: string }>;

    if (activeOrg) {
      const activeId = (activeOrg as { id: string }).id;
      if (list.some((o) => o.id === activeId)) {
        setSelectedOrgId(activeId);
        return;
      }
    }

    const userName = session?.user?.name;
    if (userName) {
      const personal = list.find((o) => o.name === userName);
      if (personal) {
        setSelectedOrgId(personal.id);
        return;
      }
    }

    if (list.length === 1) {
      setSelectedOrgId(list[0].id);
    }
  }, [activeOrg, userOrgs, orgsLoading, selectedOrgId, session]);

  return { orgList, selectedOrgId, setSelectedOrgId, orgsLoading };
}
