import { Link, useNavigate } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { WorkspaceBreadcrumbSelector } from '@/components/breadcrumbs/breadcrumb-selector';
import type { EntityTabName } from '@/components/entity-tabs/types';
import { parseEntityTabSegment } from '@/components/entity-tabs/types';
import { Badge } from '@/components/ui/badge';
import { EntityIcon } from '@/components/ui/entity-icon';
import {
  type BootstrapEntityTypeSummary,
  type ResolvedNamespace,
  type ResolvePathBootstrap,
  useResolvedPath,
} from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import { getPublicBootstrap } from '@/lib/public-bootstrap';
import { HIDDEN_ENTITY_TYPE_SLUGS, VALID_TABS } from '@/lib/reserved';

const EntityPage = lazy(async () => ({
  default: (await import('@/components/entity-page')).EntityPage,
}));
const ConnectorsView = lazy(async () => ({
  default: (await import('@/components/entity-tabs/connections-tab/connector-list-view'))
    .ConnectorsView,
}));
const EventsTab = lazy(async () => ({
  default: (await import('@/components/entity-tabs/events-tab')).EventsTab,
}));
const WatchersTab = lazy(async () => ({
  default: (await import('@/components/entity-tabs/watchers-tab')).WatchersTab,
}));
const OrgSidebar = lazy(async () => ({
  default: (await import('@/components/workspace-dashboard-home')).OrgSidebar,
}));
const WorkspaceDashboardHome = lazy(async () => ({
  default: (await import('@/components/workspace-dashboard-home')).WorkspaceDashboardHome,
}));

function ViewFallback() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground">Loading...</div>
  );
}

interface OwnerResolverProps {
  owner: string;
  splat?: string;
}

export function OwnerResolver({ owner, splat }: OwnerResolverProps) {
  // Check if the last segment is a tab name, and parse tab detail segments from path
  let effectiveSplat = splat;
  let activeTab: EntityTabName | undefined;
  let watcherId: string | undefined;
  let connectorKey: string | undefined;

  if (splat) {
    const segments = splat.split('/');
    const lastSegment = segments[segments.length - 1];
    const secondToLast = segments.length >= 2 ? segments[segments.length - 2] : undefined;
    const parsedLastTab = parseEntityTabSegment(lastSegment);
    const parsedSecondToLastTab = parseEntityTabSegment(secondToLast);

    // Path like brand/atlassian/watchers/172 -> activeTab='watchers', watcherId='172'
    if (secondToLast === 'watchers' && !VALID_TABS.includes(lastSegment as EntityTabName)) {
      activeTab = 'watchers';
      watcherId = lastSegment;
      effectiveSplat = segments.slice(0, -2).join('/') || undefined;
    } else if (parsedSecondToLastTab === 'connectors' && lastSegment) {
      activeTab = 'connectors';
      connectorKey = lastSegment;
      effectiveSplat = segments.slice(0, -2).join('/') || undefined;
    } else if (parsedLastTab) {
      activeTab = parsedLastTab;
      effectiveSplat = segments.slice(0, -1).join('/') || undefined;
    }
  }

  // Namespace root resolves as the bare owner slug, while entity paths use slash prefixes.
  const path = !effectiveSplat ? owner : `/${[owner, effectiveSplat].filter(Boolean).join('/')}`;

  const { data, isLoading, error } = useResolvedPath(path, undefined, { includeBootstrap: true });
  const { session, isReady: authReady } = useAuthState();
  const navigate = useNavigate();

  // Redirect to login if not authenticated and path failed to resolve.
  // Skip the redirect for public orgs — SSR only injects a public bootstrap
  // when the org's visibility is 'public', so the bootstrap's presence on
  // this owner is a sufficient signal to let the page render anonymously.
  useEffect(() => {
    if (!isLoading && authReady && !session && (error || !data)) {
      const bootstrap = getPublicBootstrap();
      if (bootstrap?.ownerSlug === owner) return;
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
  }, [isLoading, authReady, session, data, error, navigate, owner]);

  if (isLoading || (!authReady && !data)) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">Loading...</div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <h1 className="text-2xl font-semibold">Not Found</h1>
        <p className="text-muted-foreground mt-2">We couldn't resolve this path.</p>
      </div>
    );
  }

  const workspace = data.workspace;

  if (!data.entity) {
    return (
      <OrgHome
        owner={owner}
        workspace={workspace}
        activeTab={activeTab}
        watcherId={watcherId}
        connectorKey={connectorKey}
        bootstrap={data.bootstrap}
      />
    );
  }

  return (
    <Suspense fallback={<ViewFallback />}>
      <EntityPage
        namespace={workspace}
        path={data.path}
        entity={data.entity}
        childEntities={data.children}
        siblings={data.siblings}
        activeTab={activeTab}
        watcherId={watcherId}
        connectorKey={connectorKey}
        bootstrap={data.bootstrap}
      />
    </Suspense>
  );
}

function EntityTypeCards({
  owner,
  entityTypes,
}: {
  owner: string;
  entityTypes: BootstrapEntityTypeSummary[];
}) {
  const filteredEntityTypes = entityTypes.filter((et) => !HIDDEN_ENTITY_TYPE_SLUGS.has(et.slug));

  if (filteredEntityTypes.length === 0) return null;

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Entity Types</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filteredEntityTypes.map((et) => (
          <Link
            key={et.id}
            to={`/${owner}/${et.slug}` as '/'}
            className="block rounded-xl border bg-muted/20 px-4 py-3 transition-colors hover:bg-muted/35"
          >
            <div className="flex items-center gap-3">
              <EntityIcon icon={et.icon} className="h-5 w-5 text-primary" fallback="📦" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{et.name}</p>
                  {et.entity_count != null && et.entity_count > 0 && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {et.entity_count}
                    </Badge>
                  )}
                </div>
                {et.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{et.description}</p>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function OrgHome({
  owner,
  workspace,
  activeTab,
  watcherId,
  connectorKey,
  bootstrap,
}: {
  owner: string;
  workspace: ResolvedNamespace;
  activeTab?: EntityTabName;
  watcherId?: string;
  connectorKey?: string;
  bootstrap: ResolvePathBootstrap | null;
}) {
  const navigate = useNavigate();
  const headerContent = (
    <EntityTypeCards owner={owner} entityTypes={bootstrap?.entity_types ?? []} />
  );

  const sidebarContent = (
    <Suspense fallback={null}>
      <OrgSidebar
        orgId={workspace.id}
        ownerSlug={owner}
        agentsPath={`/${owner}/agents`}
      />
    </Suspense>
  );

  const defaultOverviewContent = (
    <Suspense fallback={<ViewFallback />}>
      <WorkspaceDashboardHome
        owner={owner}
        headerContent={headerContent}
        sidebarContent={sidebarContent}
        bootstrap={bootstrap}
      />
    </Suspense>
  );

  return (
    <div className="flex flex-1 flex-col gap-6 py-4 px-4 lg:px-6">
      {/* Header */}
      <div className="space-y-2">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <WorkspaceBreadcrumbSelector
            currentSlug={owner}
            currentName={workspace.name || workspace.slug}
          />
        </nav>
        <div className="flex items-center gap-2">
          <Sparkles className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-semibold leading-tight">
            {workspace.name || workspace.slug}
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Workspace home for agents, connectors, knowledge, and watchers.
        </p>
      </div>

      {activeTab === 'watchers' && (
        <Suspense fallback={<ViewFallback />}>
          <WatchersTab organizationId={workspace.id} ownerSlug={owner} watcherId={watcherId} />
        </Suspense>
      )}
      {activeTab === 'connectors' && (
        <Suspense fallback={<ViewFallback />}>
          <ConnectorsView
            organizationId={workspace.id}
            ownerSlug={owner}
            selectedConnectorKey={connectorKey}
            onSelectConnector={(nextConnectorKey) => {
              void navigate({
                to: `/${owner}/connectors/${nextConnectorKey}` as '/',
              });
            }}
            onCloseSelectedConnector={() => {
              void navigate({ to: `/${owner}/connectors` as '/' });
            }}
          />
        </Suspense>
      )}
      {activeTab === 'events' && (
        <Suspense fallback={<ViewFallback />}>
          <EventsTab
            organizationId={workspace.id}
            ownerSlug={owner}
            entityId={undefined}
            entityName={workspace.name || workspace.slug}
            entityBasePath={`/${owner}`}
          />
        </Suspense>
      )}
      {!activeTab || activeTab === 'overview' ? defaultOverviewContent : null}
    </div>
  );
}
