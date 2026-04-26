import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentOrg } from '@/hooks/use-current-org';
import { useOrgContext } from '@/hooks/use-org-context';
import { API_URL, fetchWithTimeout } from '@/lib/api/core';

export function PublicOrgJoinBar() {
  const { session, urlOrgSlug } = useOrgContext();
  const { org, isMember, isPublic } = useCurrentOrg();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isJoining, setIsJoining] = useState(false);

  if (!org || !urlOrgSlug || !isPublic || isMember) return null;

  const handleJoin = async () => {
    if (!session) {
      navigate({
        to: '/auth/$pathname',
        params: { pathname: 'sign-in' },
        search: {
          callbackUrl: window.location.pathname + window.location.search,
          mode: undefined,
          error: undefined,
          errorDescription: undefined,
          loginHint: undefined,
          invitationOrg: urlOrgSlug,
        },
      });
      return;
    }

    setIsJoining(true);
    try {
      const response = await fetchWithTimeout(`${API_URL}/api/${urlOrgSlug}/join`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to join (${response.status})`);
      }
      toast.success(`Joined ${org.name}`);
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to join workspace');
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div className="sticky top-0 z-30 border-b border-border bg-primary/5 backdrop-blur-sm">
      <div className="mx-auto flex max-w-screen-2xl items-center gap-3 px-4 py-2 lg:px-6">
        <Users className="h-4 w-4 shrink-0 text-primary" />
        <p className="flex-1 text-sm">
          You're browsing <span className="font-medium">{org.name}</span> as a visitor.
          {session ? ' Join to contribute and see full workspace details.' : ' Sign in to join this workspace.'}
        </p>
        <Button size="sm" onClick={handleJoin} disabled={isJoining}>
          {isJoining ? 'Joining…' : session ? `Join ${org.name}` : 'Sign in to join'}
        </Button>
      </div>
    </div>
  );
}
