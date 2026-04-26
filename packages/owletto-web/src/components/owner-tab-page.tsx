import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { WorkspaceBreadcrumbSelector } from '@/components/breadcrumbs/breadcrumb-selector';
import { useWorkspaceRoot } from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';

interface OwnerTabPageProps {
  owner: string;
  tabSegment: 'connectors' | 'events' | 'watchers';
  title: string;
  /** When set, the h1 shows this name and the breadcrumb adds it after the tab title */
  itemName?: string | null;
  children: (props: {
    organizationId: string;
    ownerSlug: string;
    setItemName: (name: string | null) => void;
  }) => ReactNode;
}

export function OwnerTabPage({
  owner,
  tabSegment,
  title,
  itemName: itemNameProp,
  children,
}: OwnerTabPageProps) {
  const { data, isLoading } = useWorkspaceRoot(owner, { slug: owner });
  const { session, isReady: authReady } = useAuthState();
  const navigate = useNavigate();
  const [childItemName, setChildItemName] = useState<string | null>(null);
  const itemName = itemNameProp ?? childItemName;
  const setItemName = useCallback((name: string | null) => setChildItemName(name), []);

  // Redirect to login if not authenticated and data failed to load
  useEffect(() => {
    if (!isLoading && authReady && !session && !data?.workspace) {
      void navigate({
        to: '/auth/$pathname',
        params: { pathname: 'sign-in' },
        search: {
          callbackUrl: window.location.pathname + window.location.search,
          mode: undefined,
          error: undefined,
          errorDescription: undefined,
          loginHint: undefined,
          invitationOrg: undefined,
        },
        replace: true,
      });
    }
  }, [isLoading, authReady, session, data, navigate]);

  if (isLoading || !authReady) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">Loading...</div>
    );
  }

  const workspace = data?.workspace;
  const TAB_ICONS: Record<OwnerTabPageProps['tabSegment'], string> = {
    connectors: '🔗',
    events: '🧾',
    watchers: '💡',
  };

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        Organization not found
      </div>
    );
  }

  if (workspace.type !== 'organization') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-muted-foreground max-w-md">
          Select an organization from the sidebar to view {title.toLowerCase()}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 py-4 md:py-6">
      <div className="space-y-2 px-4 lg:px-6">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <WorkspaceBreadcrumbSelector
            currentSlug={workspace.slug}
            currentName={workspace.name || workspace.slug}
          />
          <span>/</span>
          <Link
            to={`/${workspace.slug}/${tabSegment}` as '/'}
            className={
              itemName ? 'hover:text-foreground' : 'text-foreground hover:text-foreground/80'
            }
          >
            {title}
          </Link>
          {itemName && (
            <>
              <span>/</span>
              <span className="text-foreground">{itemName}</span>
            </>
          )}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            to={`/${workspace.slug}/${tabSegment}` as '/'}
            className="text-2xl leading-none hover:opacity-80 transition-opacity"
          >
            {TAB_ICONS[tabSegment]}
          </Link>
          <h1 className="text-3xl font-semibold leading-tight">{itemName || title}</h1>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        {children({
          organizationId: workspace.id,
          ownerSlug: workspace.slug,
          setItemName,
        })}
      </div>
    </div>
  );
}
