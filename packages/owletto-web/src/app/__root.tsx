import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Menu, Search } from 'lucide-react';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { CommandPalette } from '@/components/command-palette';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { PublicOrgJoinBar } from '@/components/public-org-join-bar';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { useOrgContext } from '@/hooks/use-org-context';
import type { Session } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { hasPublicBootstrapForPath } from '@/lib/public-bootstrap';
import { useInvalidationSSE } from '@/lib/use-invalidation-sse';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function MobileHeader({
  session,
  isPending,
  onSidebarOpen,
}: {
  session: Session | null;
  isPending: boolean;
  onSidebarOpen: () => void;
}) {
  const { activeOrg, activeOrgSlug } = useOrgContext();

  const userImage = (session?.user as { image?: string | null })?.image;
  const orgName = activeOrg?.name || session?.user?.name || 'Lobu';
  const orgLogo = activeOrg?.logo || userImage || undefined;
  const orgInitial = orgName[0]?.toUpperCase() || 'L';
  const orgHref = activeOrgSlug ? `/${activeOrgSlug}` : '/';

  const openCommandPalette = () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
    );
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background md:hidden">
      <div className="flex h-14 items-center px-4 gap-2">
        {/* Hamburger menu */}
        <button
          type="button"
          onClick={onSidebarOpen}
          className="shrink-0 p-1 -ml-1 text-muted-foreground hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Org indicator */}
        <Link to={orgHref as '/'} className="flex items-center gap-2 min-w-0 shrink">
          <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center overflow-hidden shrink-0">
            {orgLogo ? (
              <img
                src={orgLogo}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="text-foreground font-semibold text-sm">{orgInitial}</span>
            )}
          </div>
          <span className="font-semibold truncate">{orgName}</span>
        </Link>

        <div className="flex-1" />

        {/* Search trigger */}
        {session && (
          <button
            type="button"
            onClick={openCommandPalette}
            className="flex items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            <Search className="h-3.5 w-3.5" />
            <kbd className="font-mono">⌘K</kbd>
          </button>
        )}

        {/* Notifications */}
        {session && <NotificationBell />}

        {/* Sign in link for unauthenticated users */}
        {!isPending && !session && (
          <Link
            to="/auth/$pathname"
            params={{ pathname: 'sign-in' }}
            search={{
              callbackUrl: undefined,
              mode: undefined,
              error: undefined,
              errorDescription: undefined,
              loginHint: undefined,
              invitationOrg: undefined,
            }}
            className="text-sm font-medium"
          >
            Sign In
          </Link>
        )}

        {/* User avatar */}
        {session && (
          <Link to="/account/settings" className="shrink-0">
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
              {userImage ? (
                <img
                  src={userImage}
                  alt=""
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="text-foreground text-xs font-medium">
                  {session.user?.name?.[0]?.toUpperCase() ||
                    session.user?.email?.[0]?.toUpperCase() ||
                    '?'}
                </span>
              )}
            </div>
          </Link>
        )}
      </div>
    </header>
  );
}

function RootLayout() {
  const { session, isReady: authReady } = useAuthState();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const routerState = useRouterState();
  const isStandalonePage = routerState.location.pathname.startsWith('/oauth/');
  const isAuthRoute = routerState.location.pathname.startsWith('/auth/');
  const hasPublicBootstrap = hasPublicBootstrapForPath(routerState.location.pathname);

  // Extract org slug from URL path (first segment, e.g. /u_xxx/general -> u_xxx)
  // Skip non-org routes like /auth, /connect, /dashboard
  const firstSegment = routerState.location.pathname.split('/')[1] || null;
  const orgSlug =
    firstSegment && !['auth', 'dashboard'].includes(firstSegment) ? firstSegment : null;
  useInvalidationSSE(authReady && session ? orgSlug : null);

  // Standalone pages (connect flow) render without sidebar/header
  if (isStandalonePage) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
    );
  }

  if (!authReady && !isAuthRoute && !hasPublicBootstrap) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Command Palette */}
      <CommandPalette />
      <Toaster richColors position="bottom-right" />

      {/* Sidebar */}
      <AppSidebar mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} />

      {/* Mobile Header */}
      <MobileHeader
        session={session}
        isPending={!authReady}
        onSidebarOpen={() => setMobileSidebarOpen(true)}
      />

      {/* Main Content */}
      <main className="md:pl-64">
        <PublicOrgJoinBar />
        <Outlet />
      </main>

      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </div>
  );
}
