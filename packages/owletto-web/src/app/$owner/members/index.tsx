import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { WorkspaceBreadcrumbSelector } from '@/components/breadcrumbs/breadcrumb-selector';
import { Button } from '@/components/ui/button';
import { useCurrentOrg } from '@/hooks/use-current-org';
import { useAuthState } from '@/lib/auth-state';

export const Route = createFileRoute('/$owner/members/')({
  component: MembersGate,
});

function MembersGate() {
  const { owner } = Route.useParams();
  const { isAuthenticated, isReady } = useAuthState();
  const { isMember, isLoading: isOrgLoading } = useCurrentOrg();

  if (!isReady || isOrgLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">Loading...</div>
    );
  }

  if (!isAuthenticated) {
    return (
      <MembersGatePrompt
        owner={owner}
        title="Sign in to see members"
        body="The members of this workspace are only visible to people who have signed in."
        ctaLabel="Sign in"
        ctaTarget="sign-in"
      />
    );
  }

  if (!isMember) {
    return (
      <MembersGatePrompt
        owner={owner}
        title="Join to see members"
        body="Emails and member details are only visible to members of this workspace. Use the banner above to join."
      />
    );
  }

  return <Navigate to={`/${owner}/%24member` as '/'} replace />;
}

function MembersGatePrompt({
  owner,
  title,
  body,
  ctaLabel,
  ctaTarget,
}: {
  owner: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaTarget?: 'sign-in';
}) {
  return (
    <div className="flex flex-1 flex-col gap-6 py-4 px-4 lg:px-6">
      <div className="space-y-2">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <WorkspaceBreadcrumbSelector currentSlug={owner} currentName={owner} />
          <span>/</span>
          <span className="text-foreground">Members</span>
        </nav>
        <div className="flex items-center gap-2">
          <Users className="h-7 w-7" />
          <h1 className="text-3xl font-semibold leading-tight">Members</h1>
        </div>
      </div>

      <div className="mx-auto mt-12 max-w-md rounded-xl border border-dashed px-6 py-10 text-center">
        <Users className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        {ctaLabel && ctaTarget ? (
          <Button asChild className="mt-6">
            <Link
              to="/auth/$pathname"
              params={{ pathname: ctaTarget }}
              search={{
                callbackUrl: `/${owner}/members`,
                mode: undefined,
                error: undefined,
                errorDescription: undefined,
                loginHint: undefined,
                invitationOrg: undefined,
              }}
            >
              {ctaLabel}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
