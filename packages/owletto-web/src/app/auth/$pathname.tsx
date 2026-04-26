import { createFileRoute, Navigate } from '@tanstack/react-router';
import { pruneSearch } from '@/lib/router-search';

export const Route = createFileRoute('/auth/$pathname')({
  component: LegacyAuthRedirect,
  validateSearch: (search: Record<string, unknown>) =>
    pruneSearch({
      callbackUrl: (search.callbackUrl as string) || undefined,
      mode: (search.mode as string) || undefined,
      error: (search.error as string) || undefined,
      errorDescription: (search.error_description as string) || undefined,
      loginHint: (search.loginHint as string) || (search.login_hint as string) || undefined,
      invitationOrg: (search.invitationOrg as string) || undefined,
    }),
});

function LegacyAuthRedirect() {
  const { pathname } = Route.useParams();
  const search = Route.useSearch();
  const intent =
    pathname === 'sign-up' || pathname === 'signup' ? ('sign-up' as const) : ('sign-in' as const);

  return <Navigate to="/auth/login" search={{ ...search, intent }} replace />;
}
