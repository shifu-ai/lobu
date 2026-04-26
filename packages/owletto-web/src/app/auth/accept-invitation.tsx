import { AcceptInvitationCard, SignedIn } from '@daveyplate/better-auth-ui';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { API_URL } from '@/lib/api/core';
import { useAuthState } from '@/lib/auth-state';
import { pruneSearch } from '@/lib/router-search';

interface InvitationPreview {
  email: string;
  organizationName: string;
}

export const Route = createFileRoute('/auth/accept-invitation')({
  component: AcceptInvitationPage,
  // Accept both `invitationId` (new) and `id` (legacy, for invitation emails
  // already delivered before the param rename). AcceptInvitationCard reads
  // `invitationId` from the URL, so we normalize here.
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      invitationId:
        (search.invitationId as string | undefined) ||
        (search.id as string | undefined) ||
        undefined,
    }),
});

function AcceptInvitationPage() {
  const { session, sessionResult } = useAuthState();
  const { invitationId } = Route.useSearch();
  const redirectingRef = useRef(false);

  // If not signed in, fetch a preview so we can prefill the login page,
  // then full-page redirect (so `invitationOrg` / `loginHint` survive in the URL).
  useEffect(() => {
    if (sessionResult.isPending || session || !invitationId) return;
    if (redirectingRef.current) return;
    redirectingRef.current = true;

    (async () => {
      let preview: InvitationPreview | null = null;
      try {
        const res = await fetch(
          `${API_URL}/api/invitation-preview?id=${encodeURIComponent(invitationId)}`,
          { credentials: 'omit' }
        );
        if (res.ok) preview = (await res.json()) as InvitationPreview;
      } catch {
        // Preview is best-effort; fall through to plain login redirect.
      }

      const loginUrl = new URL('/auth/login', window.location.origin);
      loginUrl.searchParams.set(
        'callbackUrl',
        `/auth/accept-invitation?invitationId=${encodeURIComponent(invitationId)}`
      );
      if (preview) {
        loginUrl.searchParams.set('loginHint', preview.email);
        loginUrl.searchParams.set('invitationOrg', preview.organizationName);
      }
      window.location.href = loginUrl.toString();
    })();
  }, [session, sessionResult.isPending, invitationId]);

  // Signed-in user landed here without an invitation ID — show an explicit
  // error rather than an empty page (AcceptInvitationCard renders nothing
  // when it can't find the param).
  if (session && !invitationId) {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <XCircle className="mx-auto h-10 w-10 text-destructive mb-4" />
          <h1 className="text-xl font-semibold">Invitation not found</h1>
          <p className="text-muted-foreground mt-2">
            This invitation link is missing its ID. Ask the person who invited you to resend it.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-4">
      <SignedIn>
        <AcceptInvitationCard />
      </SignedIn>
    </div>
  );
}
