import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { Bot, ChevronDown, LogOut, Pencil, Plus, Settings2, Sparkles, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { EntityTypeSheet } from '@/components/settings/entity-types/entity-type-sheet';
import { EntityIcon } from '@/components/ui/entity-icon';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useClickOutside } from '@/hooks/use-click-outside';
import { useFeatures } from '@/hooks/use-features';
import { useOrgContext } from '@/hooks/use-org-context';
import {
  type EntityTypeAdmin,
  useEntityTypes,
  useOrganizations,
  useResolvedPath,
  useWorkspaceBootstrap,
} from '@/lib/api';
import { organization, signOut } from '@/lib/auth';
import { useAuthState } from '@/lib/auth-state';
import { HIDDEN_ENTITY_TYPE_SLUGS } from '@/lib/reserved';
import {
  deriveSidebarResolvePath,
  isDashboardPathActive,
  isSectionPathActive,
  pathsMatch,
} from './app-sidebar.helpers';
import { OrganizationDropdown } from './organization-dropdown';

// User Dropdown Component
function UserDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { session } = useAuthState();

  const close = useCallback(() => setIsOpen(false), []);
  useClickOutside(dropdownRef, close);

  const handleSettings = () => {
    setIsOpen(false);
    navigate({ to: '/account/settings' });
  };

  const handleSignOut = async () => {
    setIsOpen(false);
    await signOut();
    window.location.href = '/';
  };

  if (!session) return null;

  const sessionLike = session as {
    user?: { name?: string | null; email?: string | null; image?: string | null };
    session?: { user?: { name?: string | null; email?: string | null; image?: string | null } };
  };
  const user = sessionLike.user ?? sessionLike.session?.user;
  if (!user) return null;

  const displayName = user.name || 'User';
  const displayEmail = user.email || '';
  const displayImage = user.image;
  const displayInitial = (user.name?.[0] || user.email?.[0] || 'U').toUpperCase();

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 w-full px-2 py-1.5 rounded-lg hover:bg-sidebar-accent transition-colors cursor-pointer"
      >
        <div className="h-8 w-8 rounded-full bg-sidebar-foreground/10 flex items-center justify-center overflow-hidden shrink-0">
          {displayImage ? (
            <img
              src={displayImage}
              alt=""
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="text-sidebar-foreground font-semibold text-sm">{displayInitial}</span>
          )}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <p className="text-xs text-sidebar-foreground/50 truncate">{displayEmail}</p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-sidebar-foreground/50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border border-border rounded-lg shadow-lg z-50 py-1 min-w-[200px]">
          {/* User info header */}
          <div className="flex items-center gap-3 px-3 py-2 border-b border-border">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0">
              {displayImage ? (
                <img
                  src={displayImage}
                  alt=""
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="text-sm font-medium">{displayInitial}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{displayEmail}</p>
            </div>
          </div>

          {/* Menu items */}
          <button
            type="button"
            onClick={handleSettings}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Settings2 className="h-4 w-4" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors text-destructive"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  );
}

function EntityTypeItem({
  entityType,
  owner,
  editMode,
  onEdit,
}: {
  entityType: EntityTypeAdmin;
  owner: string | null;
  editMode?: boolean;
  onEdit?: (et: EntityTypeAdmin) => void;
}) {
  const location = useLocation();
  if (!owner) return null;
  const encodedSlug = entityType.slug.startsWith('$')
    ? `%24${entityType.slug.slice(1)}`
    : entityType.slug;
  const listPath = `/${owner}/${encodedSlug}`;
  const decodedListPath = `/${owner}/${entityType.slug}`;
  const decodedPrefix = `${decodedListPath}/`;
  const isActive =
    location.pathname === decodedListPath ||
    location.pathname === `${decodedListPath}/` ||
    location.pathname.startsWith(decodedPrefix);

  return (
    <div className="flex items-center group">
      <Link
        to={listPath as '/'}
        className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors flex-1 min-w-0 ${
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
        }`}
      >
        <span className="w-5 text-center shrink-0 flex items-center justify-center">
          <EntityIcon icon={entityType.icon} />
        </span>
        <span className="flex-1 truncate">{entityType.name}</span>
        {!editMode && (entityType.entity_count ?? 0) > 0 && (
          <span className="text-xs text-sidebar-foreground/40 tabular-nums">
            {entityType.entity_count}
          </span>
        )}
      </Link>
      {editMode && onEdit && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit(entityType);
          }}
          className="shrink-0 p-1 mr-1 text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors rounded"
          title={`Edit ${entityType.name}`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function NavItem({
  to,
  icon,
  children,
  badge,
  count,
  isActive,
  isSecondaryActive,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  badge?: string;
  count?: number;
  isActive?: boolean;
  isSecondaryActive?: boolean;
}) {
  const location = useLocation();
  const active = isActive ?? pathsMatch(location.pathname, to);

  return (
    <Link
      to={to}
      className={`relative flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors flex-1 min-w-0 ${
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : isSecondaryActive
            ? 'text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      }`}
    >
      {isSecondaryActive && !active && (
        <span className="absolute left-1 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-sidebar-accent-foreground" />
      )}
      {icon}
      <span className="flex-1">{children}</span>
      {badge && (
        <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded">{badge}</span>
      )}
      {count != null && (
        <span className="text-xs text-sidebar-foreground/40 tabular-nums">
          {count.toLocaleString()}
        </span>
      )}
    </Link>
  );
}

export function AppSidebar({
  mobileOpen = false,
  onMobileOpenChange,
}: {
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}) {
  const { session, isReady: authReady } = useAuthState();
  const { data: orgs } = useOrganizations();
  const organizations = orgs || [];
  const features = useFeatures();

  const location = useLocation();
  const { activeOrg, urlOwner, currentOwner, orgContext, personalOrgSlug } = useOrgContext();
  const autoActivatedOrgIdRef = useRef<string | null>(null);
  const isWorkspaceRoute = Boolean(urlOwner && !urlOwner.startsWith('@'));
  const sidebarOwner = isWorkspaceRoute ? currentOwner : null;
  const sidebarOrgContext = isWorkspaceRoute ? orgContext : null;

  const resolvePath = useMemo(
    () =>
      deriveSidebarResolvePath({
        currentOwner: sidebarOwner,
        locationPathname: location.pathname,
      }),
    [sidebarOwner, location.pathname]
  );

  const { data: currentPathData } = useResolvedPath(resolvePath || '', undefined);
  const { data: workspaceData } = useWorkspaceBootstrap(sidebarOwner);
  const { data: entityTypesData = [], isLoading: isEntityTypesLoading } =
    useEntityTypes(sidebarOrgContext);

  // Helper to build owner-prefixed paths
  const buildOwnerPath = (path: string) => {
    if (!sidebarOwner) return path;
    const basePath = `/${sidebarOwner}`;
    return path === '/' ? basePath : `${basePath}${path}`;
  };

  // Sync Better Auth active org based on URL, or bootstrap to personal org
  useEffect(() => {
    if (!authReady || !session || organizations.length === 0) return;

    let targetOrgId: string | null = null;

    // If on an org URL, sync active org to match
    if (urlOwner && !urlOwner.startsWith('@')) {
      const matchedOrg = organizations.find((org) => org.slug === urlOwner);
      if (matchedOrg && matchedOrg.id !== activeOrg?.id) {
        targetOrgId = matchedOrg.id;
      }
    } else if (!activeOrg?.id && personalOrgSlug) {
      // No URL org and no active org yet — set to personal org
      const personalOrg = organizations.find((org) => org.slug === personalOrgSlug);
      if (personalOrg) {
        targetOrgId = personalOrg.id;
      }
    }

    if (!targetOrgId || targetOrgId === activeOrg?.id) {
      autoActivatedOrgIdRef.current = null;
      return;
    }

    if (autoActivatedOrgIdRef.current === targetOrgId) {
      return;
    }

    autoActivatedOrgIdRef.current = targetOrgId;
    void organization.setActive({ organizationId: targetOrgId });
  }, [authReady, session, activeOrg?.id, organizations, urlOwner, personalOrgSlug]);

  const entityTypes = entityTypesData.map((entityType) => ({
    ...entityType,
    description: entityType.description ?? undefined,
    icon: entityType.icon ?? undefined,
    color: entityType.color ?? undefined,
  }));
  const isLoadingTypes = isWorkspaceRoute && isEntityTypesLoading;
  const visibleEntityTypes =
    entityTypes?.filter((entityType) => !HIDDEN_ENTITY_TYPE_SLUGS.has(entityType.slug)) || [];
  const dashboardPath = sidebarOwner ? `/${sidebarOwner}` : '/';
  const isDashboardActive = isDashboardPathActive({
    locationPathname: location.pathname,
    dashboardPath,
    currentOwner: sidebarOwner,
  });
  const currentEntity = currentPathData?.entity;
  const bootstrapSummary = workspaceData?.bootstrap?.summary;

  const connectionsCount = currentEntity
    ? currentEntity.active_connections
    : bootstrapSummary?.active_connections;
  const feedCount = currentEntity ? currentEntity.total_content : bootstrapSummary?.total_content;
  const watchersCount = currentEntity
    ? currentEntity.watchers_count
    : bootstrapSummary?.watchers_count;

  // Detect active tab when viewing an entity (e.g. /brand/atlassian/watchers/172)
  const activeEntityTab = useMemo(() => {
    if (!currentEntity) return null;
    const pathname = location.pathname;
    if (pathname.includes('/watchers')) return 'watchers';
    if (pathname.includes('/connectors')) return 'connectors';
    if (pathname.includes('/connector')) return 'connectors';
    if (pathname.includes('/connections')) return 'connectors';
    if (pathname.includes('/events')) return 'events';
    return null;
  }, [currentEntity, location.pathname]);

  // Build tab paths scoped to current entity when inside one, otherwise workspace-level
  const connectionsPath =
    currentEntity && resolvePath ? `${resolvePath}/connectors` : buildOwnerPath('/connectors');
  const eventsPath =
    currentEntity && resolvePath ? `${resolvePath}/events` : buildOwnerPath('/events');
  const watchersPath =
    currentEntity && resolvePath ? `${resolvePath}/watchers` : buildOwnerPath('/watchers');
  const isWorkspaceConnectionsActive =
    !currentEntity &&
    isSectionPathActive({
      locationPathname: location.pathname,
      sectionPath: connectionsPath,
    });
  const isWorkspaceEventsActive =
    !currentEntity &&
    isSectionPathActive({
      locationPathname: location.pathname,
      sectionPath: eventsPath,
    });
  const isWorkspaceWatchersActive =
    !currentEntity &&
    isSectionPathActive({
      locationPathname: location.pathname,
      sectionPath: watchersPath,
    });

  const [sidebarEditMode, setSidebarEditMode] = useState(false);
  // null = closed, 'create' = create form, EntityTypeAdmin = edit form
  const [editingEntityType, setEditingEntityType] = useState<EntityTypeAdmin | 'create' | null>(
    null
  );

  useEffect(() => {
    const editEntityTypes = (location.search as Record<string, unknown> | undefined)
      ?.editEntityTypes;
    const shouldOpen =
      isWorkspaceRoute &&
      (editEntityTypes === true ||
        editEntityTypes === 'true' ||
        editEntityTypes === 1 ||
        editEntityTypes === '1');

    if (shouldOpen) {
      setSidebarEditMode(true);
      return;
    }

    if (!isWorkspaceRoute) {
      setSidebarEditMode(false);
      setEditingEntityType(null);
    }
  }, [isWorkspaceRoute, location.search]);

  const sidebarContent = (
    <>
      {/* Header with organization dropdown */}
      <div className="flex h-14 items-center justify-between px-2 border-b border-sidebar-border">
        <OrganizationDropdown />
        <div className="flex items-center gap-1">
          <NotificationBell />
          <button
            type="button"
            onClick={() =>
              document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
              )
            }
            className="flex items-center gap-1 px-2 py-1 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground bg-sidebar-accent/50 rounded-md transition-colors shrink-0"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Search</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <span>⌘K</span>
          </button>
        </div>
      </div>

      {/* Main navigation */}
      <div className="flex-1 overflow-y-auto py-2">
        {/* Quick nav */}
        <div className="px-2 space-y-0.5">
          <NavItem
            to={dashboardPath}
            isActive={isDashboardActive}
            icon={<Sparkles className="h-4 w-4" />}
          >
            Dashboard
          </NavItem>
        </div>

        {/* Entity types */}
        {isWorkspaceRoute && (
          <div className="mt-4 px-2 space-y-0.5">
            <div className="flex items-center justify-between px-3 py-1">
              <div className="flex items-center gap-2 text-xs font-medium text-sidebar-foreground/50 uppercase tracking-wider">
                <span>Entities</span>
                {isWorkspaceRoute && (
                  <button
                    type="button"
                    onClick={() => setSidebarEditMode(!sidebarEditMode)}
                    className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm transition-colors ${
                      sidebarEditMode
                        ? 'text-sidebar-foreground'
                        : 'text-sidebar-foreground/40 hover:text-sidebar-foreground'
                    }`}
                    title={sidebarEditMode ? 'Exit edit mode' : 'Edit entity types'}
                  >
                    <Pencil className="h-2 w-2" />
                  </button>
                )}
              </div>
            </div>
            {isLoadingTypes ? (
              <div className="px-3 py-2 text-sm text-sidebar-foreground/50">Loading...</div>
            ) : visibleEntityTypes.length > 0 ? (
              visibleEntityTypes.map((entityType) => (
                <EntityTypeItem
                  key={entityType.id}
                  entityType={entityType}
                  owner={sidebarOwner}
                  editMode={sidebarEditMode}
                  onEdit={(et) => setEditingEntityType(et)}
                />
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-sidebar-foreground/50">
                {isWorkspaceRoute
                  ? 'No entity types'
                  : 'Select an organization to view entity types'}
              </div>
            )}
            {sidebarEditMode && (
              <button
                type="button"
                onClick={() => setEditingEntityType('create')}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors rounded-md w-full"
              >
                <Plus className="h-3.5 w-3.5" />
                Add entity type
              </button>
            )}
          </div>
        )}

        {/* Divider + context label + Data views (only when org is active and signed in) */}
        {isWorkspaceRoute && session && (
          <>
            <div className="my-3 mx-3 border-t border-sidebar-border" />
            {currentEntity && (
              <div className="px-5 pb-1 text-xs font-medium text-sidebar-foreground/40 truncate">
                {currentEntity.name}
              </div>
            )}

            <div className="px-2 space-y-0.5">
              <NavItem
                to={connectionsPath}
                count={connectionsCount}
                isActive={isWorkspaceConnectionsActive}
                isSecondaryActive={activeEntityTab === 'connectors'}
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>Connectors</title>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                    />
                  </svg>
                }
              >
                Connectors
              </NavItem>
              <NavItem
                to={eventsPath}
                count={feedCount}
                isActive={isWorkspaceEventsActive}
                isSecondaryActive={activeEntityTab === 'events'}
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>Knowledge</title>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                    />
                  </svg>
                }
              >
                Knowledge
              </NavItem>
              <NavItem
                to={watchersPath}
                count={watchersCount}
                isActive={isWorkspaceWatchersActive}
                isSecondaryActive={activeEntityTab === 'watchers'}
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <title>Watchers</title>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                }
              >
                Watchers
              </NavItem>
            </div>
          </>
        )}
      </div>

      {/* Connect section — Members and Agents are visible to anonymous visitors;
          the pages themselves render a sign-in prompt or a reduced view. */}
      {isWorkspaceRoute && sidebarOwner && (
        <div className="border-t border-sidebar-border px-3 py-2 space-y-0.5">
          <div className="flex items-center group">
            <NavItem
              to={`/${sidebarOwner}/members`}
              icon={<Users className="h-4 w-4" />}
              count={entityTypes?.find((et) => et.slug === '$member')?.entity_count}
            >
              Members
            </NavItem>
            {sidebarEditMode && (
              <button
                type="button"
                onClick={() => {
                  const memberType = entityTypes?.find((et) => et.slug === '$member');
                  if (memberType) setEditingEntityType(memberType);
                }}
                className="ml-1 p-1 rounded-sm text-sidebar-foreground/40 hover:text-sidebar-foreground transition-colors"
                title="Edit Member entity type"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
          {features.agents && (
            <NavItem to={`/${sidebarOwner}/agents`} icon={<Bot className="h-4 w-4" />}>
              Agents
            </NavItem>
          )}
        </div>
      )}

      {/* User section */}
      <div className="border-t border-sidebar-border p-3">
        {!authReady ? (
          <div className="flex items-center gap-3 px-2 py-1">
            <div className="h-8 w-8 rounded-full bg-sidebar-accent animate-pulse" />
            <div className="h-4 w-20 rounded bg-sidebar-accent animate-pulse" />
          </div>
        ) : session ? (
          <UserDropdown />
        ) : (
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
            className="flex items-center gap-2 px-2 py-1.5 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground rounded-md transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <title>Sign in</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"
              />
            </svg>
            Sign In
          </Link>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-50 w-64 border-r border-sidebar-border bg-sidebar-background text-sidebar-foreground hidden md:flex flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar sheet */}
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent
          side="left"
          className="w-64 p-0 bg-sidebar-background text-sidebar-foreground flex flex-col [&>button:last-child]:hidden"
        >
          {sidebarContent}
        </SheetContent>
      </Sheet>

      <Sheet
        open={editingEntityType !== null}
        onOpenChange={(open) => {
          if (!open) setEditingEntityType(null);
        }}
      >
        <SheetContent className="sm:max-w-2xl overflow-y-auto">
          <EntityTypeSheet
            entityType={editingEntityType === 'create' ? null : editingEntityType}
            onClose={() => setEditingEntityType(null)}
            orgContext={orgContext}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
