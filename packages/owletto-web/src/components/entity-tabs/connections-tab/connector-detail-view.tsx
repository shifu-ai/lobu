import { useParams } from '@tanstack/react-router';
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  ConnectorDisplay,
  resolveConnectorDisplay,
} from '@/components/connectors/connector-display';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useRowExpansion } from '@/hooks/use-row-expansion';
import type { ConnectionItem, FeedItem } from '@/lib/api';
import {
  useAllFeeds,
  useAuthProfiles,
  useConnections,
  useConnectorDefinitions,
  useConnectorOperations,
  useCreateAuthProfile,
  useDeleteAuthProfile,
  useFeeds,
  usePublicConnectorDetail,
  useToggleConnectorLogin,
  useUninstallConnector,
  useUpdateConnectorDefaultConfig,
} from '@/lib/api';
import type { AuthProfileItem } from '@/lib/api/connections';
import { useAuthState } from '@/lib/auth-state';
import { formatTimeAgo } from '@/lib/format-utils';
import { getStatusVariant } from '@/lib/status-variants';
import { TabErrorState, TabLoadingState } from '../tab-states';
import { AddFeedDialog } from './add-feed-dialog';
import {
  buildEnvKeysSchema,
  buildInstallAuthSchemaForMethod,
  type EnvKeysMethod,
  getAuthSchemaLabel,
  getSelectableMethods,
  type OAuthMethod,
} from './auth-helpers';
import { ConnectionSheet } from './connection-sheet';
import { ActionsPanel, FeedsPanel } from './connector-panels';
import { DynamicConnectorForm } from './dynamic-connector-form';
import { FeedExpandedRow } from './feed-expanded-row';

interface ConnectorDetailViewProps {
  organizationId: string;
  ownerSlug?: string;
  connectorKey: string;
  onBack: () => void;
  initialConnectionId?: number;
  entityId?: number;
  createdBy?: string;
}

interface FeedDef {
  name?: string;
  displayNameTemplate?: string;
}

function resolveFeedDisplayName(
  displayName: string | null | undefined,
  feedKey: string,
  config: Record<string, unknown> | null,
  feedsSchema: Record<string, FeedDef> | null
): string {
  if (displayName?.trim()) return displayName.trim();
  const def = feedsSchema?.[feedKey];
  if (!def) return feedKey;

  const template = def.displayNameTemplate;
  if (template && config) {
    const resolved = template
      .replace(/\{(\w+)\}/g, (_, key) => {
        const val = config[key];
        return val != null ? String(val) : '';
      })
      .replace(/\s*-\s*$/, '')
      .trim();
    if (resolved) return resolved;
  }

  // Fallback: use first non-empty config value + feed name
  if (config) {
    const firstVal = Object.values(config).find((v) => typeof v === 'string' && v.trim());
    if (firstVal) return `${def.name ?? feedKey}: ${firstVal}`;
  }

  return def.name ?? feedKey;
}

function ConnectionFeedsSubTable({
  connection,
  organizationId,
  feedsSchema,
  onEditConnection,
  prefetchedFeeds,
}: {
  connection: ConnectionItem;
  organizationId: string;
  feedsSchema: Record<string, FeedDef> | null;
  onEditConnection: (connectionId: number) => void;
  prefetchedFeeds?: FeedItem[];
}) {
  const { data: fetchedFeeds = [], isLoading } = useFeeds(prefetchedFeeds ? null : connection.id);
  const feeds = prefetchedFeeds ?? fetchedFeeds;
  const { toggleRow, isExpanded } = useRowExpansion();

  if (!prefetchedFeeds && isLoading) {
    return (
      <div className="flex items-center gap-2 py-3 px-4 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading feeds...
      </div>
    );
  }

  if (feeds.length === 0) {
    return (
      <div className="py-3 px-4 text-sm text-muted-foreground">
        No feeds configured. Add a feed if you want scheduled syncs.
      </div>
    );
  }

  return (
    <div className="border-l-2 border-l-primary/40 bg-muted/5">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30 hover:bg-muted/30 border-b border-border/50">
            <TableHead className="py-1.5 px-4 text-xs w-8" />
            <TableHead className="py-1.5 px-3 text-xs text-muted-foreground/70 font-medium">
              Feed
            </TableHead>
            <TableHead className="py-1.5 px-3 text-xs text-muted-foreground/70 font-medium">
              Status
            </TableHead>
            <TableHead className="py-1.5 px-3 text-xs text-muted-foreground/70 font-medium">
              Last Sync
            </TableHead>
            <TableHead className="py-1.5 px-3 text-xs text-muted-foreground/70 font-medium">
              Next Sync
            </TableHead>
            <TableHead className="py-1.5 px-3 text-xs text-muted-foreground/70 font-medium">
              Knowledge
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {feeds.map((feed) => (
            <Fragment key={feed.id}>
              <TableRow
                className="cursor-pointer hover:bg-muted/20 border-border/30"
                onClick={() => toggleRow(feed.id)}
              >
                <TableCell className="py-1.5 px-4 w-8">
                  <ChevronRight
                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded(feed.id) ? 'rotate-90' : ''}`}
                  />
                </TableCell>
                <TableCell className="py-1.5 px-3 text-xs">
                  {resolveFeedDisplayName(
                    feed.display_name,
                    feed.feed_key,
                    feed.config,
                    feedsSchema
                  )}
                </TableCell>
                <TableCell className="py-1.5 px-3 text-xs">
                  <StatusBadge status={getStatusVariant(feed.status)} showDot>
                    {feed.status}
                  </StatusBadge>
                </TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-muted-foreground">
                  {feed.last_sync_at ? formatTimeAgo(feed.last_sync_at) : '—'}
                </TableCell>
                <TableCell className="py-1.5 px-3 text-xs text-muted-foreground">
                  {feed.next_run_at ? formatTimeAgo(feed.next_run_at) : '—'}
                </TableCell>
                <TableCell className="py-1.5 px-3 text-xs font-mono text-muted-foreground">
                  {(feed.event_count ?? 0).toLocaleString()}
                </TableCell>
              </TableRow>
              {isExpanded(feed.id) && (
                <TableRow className="bg-muted/20 hover:bg-muted/20">
                  <TableCell colSpan={6} className="p-0">
                    <FeedExpandedRow
                      feed={feed}
                      organizationId={organizationId}
                      onEditConnection={onEditConnection}
                    />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ConnectorSettingsSheet({
  open,
  onOpenChange,
  organizationId,
  connectorKey,
  connectorDef,
  onUninstalled,
  hasConnections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  connectorKey: string;
  connectorDef: {
    auth_schema: Record<string, unknown> | null;
    feeds_schema: Record<string, unknown> | null;
    default_connection_config?: Record<string, unknown> | null;
    name: string;
    login_enabled: boolean;
  };
  onUninstalled: () => void;
  hasConnections: boolean;
}) {
  const { data: operations = [] } = useConnectorOperations(connectorKey);
  const { mutate: uninstallConnector, isPending: isUninstalling } = useUninstallConnector();
  const updateDefaultConfig = useUpdateConnectorDefaultConfig();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);

  const defaultConfig = connectorDef.default_connection_config ?? {};
  const autoApproveActions = (defaultConfig.auto_approve_actions as string[] | undefined) ?? [];
  const requireApprovalActions =
    (defaultConfig.require_approval_actions as string[] | undefined) ?? [];

  const handleToggleAction = (actionKey: string, checked: boolean) => {
    const op = operations.find((o) => o.operation_key === actionKey);
    if (!op) return;
    const next = { ...defaultConfig };
    if (op.requires_approval) {
      next.auto_approve_actions = checked
        ? [...new Set([...autoApproveActions, actionKey])]
        : autoApproveActions.filter((k) => k !== actionKey);
    } else {
      next.require_approval_actions = checked
        ? requireApprovalActions.filter((k) => k !== actionKey)
        : [...new Set([...requireApprovalActions, actionKey])];
    }
    updateDefaultConfig.mutate({
      connector_key: connectorKey,
      default_connection_config: next,
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Connector Settings</SheetTitle>
          <SheetDescription>
            Configure {connectorDef.name} defaults and auth profiles.
          </SheetDescription>
        </SheetHeader>

        <div className="py-6 space-y-6">
          <FeedsPanel feedsSchema={connectorDef.feeds_schema} />

          {operations.length > 0 && (
            <ActionsPanel
              operations={operations}
              autoApproveActions={autoApproveActions}
              requireApprovalActions={requireApprovalActions}
              onToggleAction={handleToggleAction}
            />
          )}

          <ConnectorSettings
            organizationId={organizationId}
            connectorKey={connectorKey}
            connectorDef={connectorDef}
          />

          <Separator />

          <div className="space-y-2">
            {!confirmingUninstall ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                disabled={hasConnections}
                onClick={() => setConfirmingUninstall(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                {hasConnections ? 'Delete connections first' : 'Uninstall Connector'}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isUninstalling}
                  onClick={() =>
                    uninstallConnector(connectorKey, {
                      onSuccess: () => {
                        onOpenChange(false);
                        onUninstalled();
                      },
                    })
                  }
                >
                  {isUninstalling ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Uninstalling...
                    </>
                  ) : (
                    'Confirm Uninstall'
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingUninstall(false)}
                  disabled={isUninstalling}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ConnectorSettings({
  organizationId,
  connectorKey,
  connectorDef,
}: {
  organizationId: string;
  connectorKey: string;
  connectorDef: {
    auth_schema: Record<string, unknown> | null;
    name: string;
    login_enabled: boolean;
  };
}) {
  const methods = getSelectableMethods(connectorDef.auth_schema);
  const hasOAuth = methods.some((m) => m.type === 'oauth');
  const oauthMethod = methods.find((m) => m.type === 'oauth') as OAuthMethod | undefined;

  const { data: authProfiles = [], refetch: refetchAuthProfiles } = useAuthProfiles(
    organizationId,
    { connectorKey, provider: oauthMethod?.provider }
  );
  const createAuthProfile = useCreateAuthProfile();
  const deleteAuthProfile = useDeleteAuthProfile();
  const toggleLogin = useToggleConnectorLogin();

  const appProfiles = authProfiles.filter(
    (p) =>
      p.profile_kind === 'oauth_app' &&
      (!oauthMethod || p.provider?.toLowerCase() === oauthMethod.provider.toLowerCase())
  );
  const envProfiles = authProfiles.filter((p) => p.profile_kind === 'env');
  const browserProfiles = authProfiles.filter((p) => p.profile_kind === 'browser_session');
  const accountProfiles = authProfiles.filter((p) => p.profile_kind === 'oauth_account');

  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileValues, setNewProfileValues] = useState<Record<string, unknown>>({});
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const appProfileSchema = useMemo(
    () => (oauthMethod ? buildInstallAuthSchemaForMethod(oauthMethod) : null),
    [oauthMethod]
  );
  const envMethod = methods.find((m) => m.type === 'env_keys') as EnvKeysMethod | undefined;
  const envProfileSchema = useMemo(
    () => (envMethod ? buildEnvKeysSchema(envMethod) : null),
    [envMethod]
  );

  const handleCreateAppProfile = async () => {
    if (!oauthMethod) return;
    const credentials = Object.fromEntries(
      Object.entries(newProfileValues)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => [k, String(v).trim()])
    );
    await createAuthProfile.mutateAsync({
      connector_key: connectorKey,
      profile_kind: 'oauth_app',
      display_name: newProfileName.trim() || `${connectorDef.name} ${oauthMethod.provider} App`,
      credentials,
    });
    setShowNewProfile(false);
    setNewProfileName('');
    setNewProfileValues({});
    void refetchAuthProfiles();
  };

  const handleCreateEnvProfile = async () => {
    const credentials = Object.fromEntries(
      Object.entries(newProfileValues)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => [k, String(v).trim()])
    );
    await createAuthProfile.mutateAsync({
      connector_key: connectorKey,
      profile_kind: 'env',
      display_name: newProfileName.trim() || `${connectorDef.name} Auth`,
      credentials,
    });
    setShowNewProfile(false);
    setNewProfileName('');
    setNewProfileValues({});
    void refetchAuthProfiles();
  };

  const handleDelete = async (slug: string) => {
    await deleteAuthProfile.mutateAsync(slug);
    setDeletingSlug(null);
    void refetchAuthProfiles();
  };

  const renderProfileList = (profiles: AuthProfileItem[]) => {
    if (profiles.length === 0) return null;
    return (
      <div className="space-y-1">
        {profiles.map((p) => (
          <div key={p.slug} className="flex items-center gap-2 text-sm">
            <Badge
              variant={p.status === 'active' ? 'default' : 'secondary'}
              className="text-[10px] px-1.5 py-0 h-4"
            >
              {p.status}
            </Badge>
            <span>{p.display_name}</span>
            <span className="text-muted-foreground text-xs">({p.slug})</span>
            {deletingSlug === p.slug ? (
              <div className="flex items-center gap-1 ml-auto">
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-6 text-xs px-2"
                  disabled={deleteAuthProfile.isPending}
                  onClick={() => void handleDelete(p.slug)}
                >
                  {deleteAuthProfile.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    'Delete'
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => setDeletingSlug(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => setDeletingSlug(p.slug)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Auth</p>
      {/* Login provider toggle */}
      {hasOAuth && (
        <div className="flex items-center gap-2">
          <Button
            variant={connectorDef.login_enabled ? 'default' : 'outline'}
            size="sm"
            onClick={() =>
              toggleLogin.mutate({
                connector_key: connectorKey,
                enabled: !connectorDef.login_enabled,
              })
            }
            disabled={toggleLogin.isPending}
          >
            {toggleLogin.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <LogIn className="h-3.5 w-3.5 mr-1.5" />
            )}
            {connectorDef.login_enabled ? 'Login Provider Enabled' : 'Enable as Login Provider'}
          </Button>
        </div>
      )}

      {/* OAuth App Profiles */}
      {hasOAuth && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            OAuth App Profiles
          </p>
          {renderProfileList(appProfiles)}
          {appProfiles.length === 0 && !showNewProfile && (
            <p className="text-xs text-muted-foreground">
              No OAuth app profiles yet — add client credentials to enable OAuth connections.
            </p>
          )}
          {!showNewProfile ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setShowNewProfile(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add App Profile
            </Button>
          ) : (
            <div className="space-y-3 rounded-md border bg-background p-3">
              <Input
                placeholder="Profile name"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
              />
              {appProfileSchema && (
                <DynamicConnectorForm
                  schema={appProfileSchema}
                  initialValues={undefined}
                  onValuesChange={setNewProfileValues}
                  fieldIdPrefix="connector-settings-app-"
                />
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowNewProfile(false);
                    setNewProfileName('');
                    setNewProfileValues({});
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    createAuthProfile.isPending ||
                    Object.values(newProfileValues).filter((v) => typeof v === 'string' && v.trim())
                      .length === 0
                  }
                  onClick={() => void handleCreateAppProfile()}
                >
                  {createAuthProfile.isPending && (
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  )}
                  Create
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Env Key Profiles */}
      {envMethod && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            API Key Profiles
          </p>
          {renderProfileList(envProfiles)}
          {envProfiles.length === 0 && !showNewProfile && (
            <p className="text-xs text-muted-foreground">No API key profiles yet.</p>
          )}
          {!hasOAuth && !showNewProfile && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setShowNewProfile(true)}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add Auth Profile
            </Button>
          )}
          {!hasOAuth && showNewProfile && (
            <div className="space-y-3 rounded-md border bg-background p-3">
              <Input
                placeholder="Profile name"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
              />
              {envProfileSchema && (
                <DynamicConnectorForm
                  schema={envProfileSchema}
                  initialValues={undefined}
                  onValuesChange={setNewProfileValues}
                  fieldIdPrefix="connector-settings-env-"
                />
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowNewProfile(false);
                    setNewProfileName('');
                    setNewProfileValues({});
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={
                    createAuthProfile.isPending ||
                    Object.values(newProfileValues).filter((v) => typeof v === 'string' && v.trim())
                      .length === 0
                  }
                  onClick={() => void handleCreateEnvProfile()}
                >
                  {createAuthProfile.isPending && (
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  )}
                  Create
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Browser Profiles */}
      {browserProfiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Browser Session Profiles
          </p>
          {renderProfileList(browserProfiles)}
        </div>
      )}

      {/* OAuth Account Profiles */}
      {accountProfiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Connected Accounts
          </p>
          {renderProfileList(accountProfiles)}
        </div>
      )}
    </div>
  );
}

export function ConnectorDetailView({
  organizationId,
  ownerSlug,
  connectorKey,
  onBack,
  initialConnectionId,
  entityId,
  createdBy,
}: ConnectorDetailViewProps) {
  const { owner } = useParams({ strict: false }) as { owner: string };
  const { isAuthenticated } = useAuthState();
  const resolvedOwnerSlug = ownerSlug ?? owner;
  const { data: publicConnectorData, isLoading: publicConnectorLoading } = usePublicConnectorDetail(
    !isAuthenticated ? resolvedOwnerSlug : null,
    !isAuthenticated ? connectorKey : null
  );
  const { data: connectorDefs = [] } = useConnectorDefinitions(
    isAuthenticated ? organizationId : null
  );
  const {
    data: allConnections = [],
    isLoading,
    error,
  } = useConnections(isAuthenticated ? organizationId : null, { connectorKey, createdBy });
  const { data: entityFeeds = [] } = useAllFeeds(
    isAuthenticated && entityId ? organizationId : null,
    { entityId }
  );
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ConnectionItem | null>(null);

  const publicConnectorDefs = useMemo(
    () => (publicConnectorData?.connector ? [publicConnectorData.connector] : []),
    [publicConnectorData]
  );

  const publicFeeds = publicConnectorData?.feeds ?? [];

  const effectiveConnectorDefs = isAuthenticated ? connectorDefs : publicConnectorDefs;
  const connectorDef = useMemo(
    () => effectiveConnectorDefs.find((c) => c.key === connectorKey),
    [effectiveConnectorDefs, connectorKey]
  );

  // When scoped to an entity, only show connections that have feeds for it
  const connections = useMemo(() => {
    if (!entityId) return allConnections;
    const entityConnectionIds = new Set(entityFeeds.map((f) => f.connection_id));
    return allConnections.filter((c) => entityConnectionIds.has(c.id));
  }, [allConnections, entityId, entityFeeds]);

  // When entity-scoped, group entityFeeds by connection to avoid N+1 queries
  const feedsByConnection = useMemo(() => {
    if (!entityId) return null;
    const map = new Map<number, FeedItem[]>();
    for (const f of entityFeeds) {
      const list = map.get(f.connection_id);
      if (list) list.push(f);
      else map.set(f.connection_id, [f]);
    }
    return map;
  }, [entityId, entityFeeds]);

  // Auto-expand all connections when scoped to an entity
  const autoExpandIds = useMemo(
    () => (entityId ? connections.map((c) => c.id) : undefined),
    [entityId, connections]
  );
  const { toggleRow, isExpanded } = useRowExpansion(autoExpandIds);

  // Auto-open edit sheet for deep-linked connectionId
  const routedEditTarget = useMemo(
    () =>
      initialConnectionId ? (connections.find((c) => c.id === initialConnectionId) ?? null) : null,
    [connections, initialConnectionId]
  );
  const activeEditTarget = routedEditTarget ?? editTarget;

  const handleEditConnection = useCallback(
    (connectionId: number) => {
      const conn = connections.find((c) => c.id === connectionId);
      if (conn) setEditTarget(conn);
    },
    [connections]
  );

  const authLabel = connectorDef ? getAuthSchemaLabel(connectorDef.auth_schema) : null;

  if ((isAuthenticated && isLoading) || (!isAuthenticated && publicConnectorLoading)) {
    return <TabLoadingState label="connections" />;
  }
  if (error) return <TabErrorState label="connections" />;

  if (!isAuthenticated) {
    if (!connectorDef) return <TabErrorState label="connectors" />;

    return (
      <div className="space-y-6">
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <ConnectorDisplay
              connector={resolveConnectorDisplay(
                connectorKey,
                new Map([[connectorKey, connectorDef]]),
                { name: connectorDef.name }
              )}
              showDescription={false}
              nameClassName="text-lg font-semibold"
            />
            {authLabel && (
              <Badge variant="outline" className="text-xs">
                {authLabel}
              </Badge>
            )}
            {connectorDef.login_enabled && (
              <Badge variant="secondary" className="text-xs gap-1">
                Login Provider
              </Badge>
            )}
          </div>
        </div>

        {connectorDef.description ? (
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">{connectorDef.description}</p>
          </div>
        ) : null}

        <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
          Public view is read-only. Sign in to add connections, manage feeds, or change settings.
        </div>

        {connectorDef?.feeds_schema && Object.keys(connectorDef.feeds_schema).length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              Available Feeds
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(connectorDef.feeds_schema).map(([key, v]) => {
                const feed = v as { name?: string; description?: string };
                return (
                  <div key={key} className="rounded-md border bg-card px-3 py-2 text-sm">
                    <span className="font-medium">{feed.name ?? key}</span>
                    {feed.description && (
                      <span className="text-muted-foreground ml-1.5">- {feed.description}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Public Feeds
          </p>
          {publicFeeds.length === 0 ? (
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              No public feeds are configured for this connector yet.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Feed</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Sync</TableHead>
                    <TableHead>Next Sync</TableHead>
                    <TableHead>Knowledge</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {publicFeeds.map((feed) => (
                    <TableRow key={feed.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">
                            {resolveFeedDisplayName(
                              feed.display_name,
                              feed.feed_key,
                              feed.config,
                              (connectorDef.feeds_schema as Record<string, FeedDef> | null) ?? null
                            )}
                          </span>
                          {(feed.connection_name || feed.entity_names) && (
                            <span className="text-xs text-muted-foreground">
                              {[feed.connection_name, feed.entity_names]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={getStatusVariant(feed.status)} showDot>
                          {feed.status}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {feed.last_sync_at ? formatTimeAgo(feed.last_sync_at) : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {feed.next_run_at ? formatTimeAgo(feed.next_run_at) : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {(feed.event_count ?? 0).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {connectorDef && (
              <ConnectorDisplay
                connector={resolveConnectorDisplay(
                  connectorKey,
                  new Map([[connectorKey, connectorDef]]),
                  { name: connectorDef.name }
                )}
                showDescription={false}
                nameClassName="text-lg font-semibold"
              />
            )}
            {authLabel && (
              <Badge variant="outline" className="text-xs">
                {authLabel}
              </Badge>
            )}
            {connectorDef?.login_enabled && (
              <Badge variant="secondary" className="text-xs gap-1">
                Login Provider
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </Button>
            {connections.length > 0 && (
              <AddFeedDialog
                organizationId={organizationId}
                connections={connections}
                connectorDefinitions={connectorDefs}
              />
            )}
            <Button variant="outline" size="sm" onClick={() => setAddConnectionOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {authLabel === 'OAuth' ? 'Connect Account' : 'Add Connection'}
            </Button>
          </div>
        </div>
      </div>

      {/* Connector settings sheet */}
      {connectorDef && (
        <ConnectorSettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          organizationId={organizationId}
          connectorKey={connectorKey}
          connectorDef={connectorDef}
          onUninstalled={onBack}
          hasConnections={connections.length > 0}
        />
      )}

      {/* Connections table */}
      {connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p className="text-lg font-medium">No connections</p>
          <p className="text-sm mt-1">
            Connect an account to access it. Add feeds later if you want scheduled syncs.
          </p>
          <Button variant="outline" className="mt-4" onClick={() => setAddConnectionOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {authLabel === 'OAuth' ? 'Connect Account' : 'Add Connection'}
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Connection</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Entities</TableHead>
                <TableHead>Auth</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map((conn) => (
                <Fragment key={conn.id}>
                  <TableRow
                    className={`cursor-pointer ${
                      conn.status === 'error' || conn.status === 'revoked'
                        ? 'bg-red-50 dark:bg-red-950/20'
                        : ''
                    }`}
                    onClick={() => toggleRow(conn.id)}
                  >
                    <TableCell className="w-8">
                      <ChevronRight
                        className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded(conn.id) ? 'rotate-90' : ''}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {conn.display_name || `Connection #${conn.id}`}
                        </span>
                        {conn.visibility === 'private' && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                            Private
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {conn.created_by_username || '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <span className="truncate max-w-[200px] block">
                        {conn.entity_names || '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      {conn.auth_profile_kind ? (
                        <StatusBadge
                          status={getStatusVariant(conn.auth_profile_status ?? 'default')}
                          showDot
                        >
                          {conn.auth_profile_kind === 'env'
                            ? 'API Key'
                            : conn.auth_profile_kind === 'browser_session'
                              ? 'Browser'
                              : 'OAuth'}
                        </StatusBadge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={getStatusVariant(conn.status)}>
                          {conn.status}
                        </StatusBadge>
                        {conn.error_message && (
                          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="w-10">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTarget(conn);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit Connection
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                  {isExpanded(conn.id) && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="p-0">
                        <ConnectionFeedsSubTable
                          connection={conn}
                          organizationId={organizationId}
                          feedsSchema={
                            (connectorDef?.feeds_schema as Record<string, FeedDef> | null) ?? null
                          }
                          onEditConnection={handleEditConnection}
                          prefetchedFeeds={feedsByConnection?.get(conn.id)}
                        />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Add Connection sheet */}
      <ConnectionSheet
        open={addConnectionOpen}
        onOpenChange={setAddConnectionOpen}
        organizationId={organizationId}
        connections={connections}
        initialConnectorKey={connectorKey}
      />

      {/* Edit Connection sheet */}
      <ConnectionSheet
        open={!!activeEditTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        organizationId={organizationId}
        connections={connections}
        editingConnection={activeEditTarget}
      />
    </>
  );
}
