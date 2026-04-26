import { useQuery } from '@tanstack/react-query';
import { organization } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';

type Role = 'member' | 'admin' | 'owner';

export interface Member {
  id: string;
  userId: string;
  organizationId: string;
  role: Role;
  createdAt: Date;
  user: {
    id: string;
    name: string;
    email: string;
    image?: string;
  };
}

export interface UseMembersResult {
  members: Member[];
  isLoading: boolean;
  currentUserRole: Role | null;
  isAdmin: boolean;
}

export function useMembers(organizationId: string | undefined): UseMembersResult {
  const { session } = useAuthState();

  const { data: members = [], isLoading } = useQuery({
    queryKey: ['org-members', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      const res = await organization.listMembers({ query: { organizationId } });
      return (res.data?.members as Member[]) ?? [];
    },
    enabled: !!organizationId,
    staleTime: 60_000,
  });

  const currentUserId = session?.user?.id;
  const currentMember = currentUserId ? members.find((m) => m.userId === currentUserId) : undefined;
  const currentUserRole = (currentMember?.role as Role) ?? null;

  return {
    members,
    isLoading,
    currentUserRole,
    isAdmin: currentUserRole === 'admin' || currentUserRole === 'owner',
  };
}
