import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConnectorDisplay } from '@/components/connectors/connector-display';
import { MemberPicker } from '@/components/member-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ConnectionItem, ConnectorDefinitionItem } from '@/lib/api';
import {
  useActiveAuthRun,
  useAuthRun,
  useAvailableOperations,
  useConnectorOperations,
  useReauthenticateConnection,
  useUpdateConnection,
} from '@/lib/api/connections';
import { API_URL } from '@/lib/api/core';
import { ActionRunner } from './action-runner';
import { ArtifactRenderer } from './auth-artifact-renderer';
import { AuthFlowDialog } from './auth-flow-dialog';
import {
  EMPTY_VALUES,
  getAuthSchemaLabel,
  getBrowserMethodDefaultCdpUrl,
  getMethodLabel,
  getRequiredOAuthScopes,
  type OAuthMethod,
} from './auth-helpers';
import { ActionsPanel, ActionsSchemaPanel, FeedsPanel } from './connector-panels';
import { DynamicConnectorForm } from './dynamic-connector-form';
import { useConnectionForm } from './use-connection-form';

// ============================================================
// Component
// ============================================================

const CREATE_OAUTH_APP_PROFILE_VALUE = '__create_oauth_app_profile__';
const CREATE_OAUTH_ACCOUNT_PROFILE_VALUE = '__create_oauth_account_profile__';
const CREATE_BROWSER_PROFILE_VALUE = '__create_browser_profile__';

const OAUTH_REDIRECT_URI = `${API_URL}/connect/oauth/callback`;

function OAuthSetupInfo({ method }: { method: OAuthMethod }) {
  const [copied, setCopied] = useState(false);
  const rawInstructions = method.setupInstructions || method.description;

  const instructions = rawInstructions
    ? rawInstructions.replace(/\{\{redirect_uri\}\}/g, OAUTH_REDIRECT_URI)
    : null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      {instructions && <p className="text-xs text-muted-foreground">{instructions}</p>}
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Redirect URI</p>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono break-all">
            {OAUTH_REDIRECT_URI}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            onClick={() => {
              void navigator.clipboard.writeText(OAUTH_REDIRECT_URI);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function OAuthScopeSelector({
  requiredScopes,
  optionalScopes,
  selectedOptionalScopes,
  grantedScopes,
  onToggleOptionalScope,
}: {
  requiredScopes: string[];
  optionalScopes: string[];
  selectedOptionalScopes: string[];
  grantedScopes?: string[];
  onToggleOptionalScope: (scope: string, checked: boolean) => void;
}) {
  if (requiredScopes.length === 0 && optionalScopes.length === 0) return null;

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Required scopes</p>
        <div className="flex flex-wrap gap-1.5">
          {requiredScopes.map((scope) => (
            <Badge key={scope} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
              {scope}
            </Badge>
          ))}
        </div>
      </div>

      {optionalScopes.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Optional scopes</p>
          <div className="space-y-2">
            {optionalScopes.map((scope) => {
              const checked = selectedOptionalScopes.includes(scope);
              return (
                <div key={scope} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => onToggleOptionalScope(scope, value === true)}
                  />
                  <span>{scope}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {grantedScopes && grantedScopes.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Granted on selected account</p>
          <div className="flex flex-wrap gap-1.5">
            {grantedScopes.map((scope) => (
              <Badge key={scope} variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                {scope}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AutoApproveToggles({ connection }: { connection: ConnectionItem }) {
  const { data: operations = [] } = useAvailableOperations(connection.id);
  const updateConnection = useUpdateConnection();
  const config = (connection.config ?? {}) as Record<string, unknown>;
  const autoApproveActions = (config.auto_approve_actions ?? []) as string[];
  const requireApprovalActions = (config.require_approval_actions ?? []) as string[];

  const writeActions = operations.filter((op) => op.kind === 'write');
  if (writeActions.length === 0) return null;

  const isAutoApproved = (op: (typeof writeActions)[0]) => {
    if (op.requires_approval) return autoApproveActions.includes(op.operation_key);
    return !requireApprovalActions.includes(op.operation_key);
  };

  const toggleAction = (op: (typeof writeActions)[0], checked: boolean) => {
    const nextConfig = { ...config };
    if (op.requires_approval) {
      nextConfig.auto_approve_actions = checked
        ? [...new Set([...autoApproveActions, op.operation_key])]
        : autoApproveActions.filter((k) => k !== op.operation_key);
    } else {
      nextConfig.require_approval_actions = checked
        ? requireApprovalActions.filter((k) => k !== op.operation_key)
        : [...new Set([...requireApprovalActions, op.operation_key])];
    }
    updateConnection.mutate({ connection_id: connection.id, config: nextConfig });
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Auto-approve (skip user confirmation)
      </p>
      <div className="space-y-1">
        {writeActions.map((op) => (
          <label key={op.operation_key} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={isAutoApproved(op)}
              onChange={(e) => toggleAction(op, e.target.checked)}
              className="rounded border-input"
              disabled={updateConnection.isPending}
            />
            <span>{op.name ?? op.operation_key}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ConnectorPreview({
  connector,
  onInstall,
  onBack,
  isInstalling,
  installError,
}: {
  connector: ConnectorDefinitionItem;
  onInstall: () => void;
  onBack: () => void;
  isInstalling: boolean;
  installError: string | null;
}) {
  const authLabel = getAuthSchemaLabel(connector.auth_schema);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-7 px-2 text-xs">
          &larr; Back
        </Button>
        <ConnectorDisplay connector={connector} showDescription={false} className="gap-2" />
        {connector.version && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
            v{connector.version}
          </Badge>
        )}
      </div>

      {connector.description && (
        <div className="rounded-lg border bg-card p-3">
          <p className="text-sm text-muted-foreground">{connector.description}</p>
        </div>
      )}

      {authLabel && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Authentication
          </p>
          <p className="text-sm">{authLabel}</p>
        </div>
      )}

      <FeedsPanel feedsSchema={connector.feeds_schema} />
      <ActionsSchemaPanel actionsSchema={connector.actions_schema} />

      {installError && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600 dark:text-red-400">
          {installError}
        </div>
      )}

      <Button onClick={onInstall} disabled={isInstalling} className="w-full">
        {isInstalling ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Installing...
          </>
        ) : (
          'Install & Configure'
        )}
      </Button>
    </div>
  );
}

function CreateModeCapabilities({
  connector,
  actionConfig,
  onActionConfigChange,
}: {
  connector: ConnectorDefinitionItem;
  actionConfig: Record<string, unknown>;
  onActionConfigChange: (config: Record<string, unknown>) => void;
}) {
  const { data: operations = [] } = useConnectorOperations(
    connector.installed ? connector.key : null
  );
  const autoApproveActions = (actionConfig.auto_approve_actions as string[] | undefined) ?? [];
  const requireApprovalActions =
    (actionConfig.require_approval_actions as string[] | undefined) ?? [];

  const handleToggle = (actionKey: string, checked: boolean) => {
    const op = operations.find((o) => o.operation_key === actionKey);
    if (!op) return;
    const next = { ...actionConfig };
    if (op.requires_approval) {
      next.auto_approve_actions = checked
        ? [...new Set([...autoApproveActions, actionKey])]
        : autoApproveActions.filter((k) => k !== actionKey);
    } else {
      next.require_approval_actions = checked
        ? requireApprovalActions.filter((k) => k !== actionKey)
        : [...new Set([...requireApprovalActions, actionKey])];
    }
    onActionConfigChange(next);
  };

  return (
    <>
      <FeedsPanel feedsSchema={connector.feeds_schema} />
      {operations.length > 0 ? (
        <ActionsPanel
          operations={operations}
          autoApproveActions={autoApproveActions}
          requireApprovalActions={requireApprovalActions}
          onToggleAction={handleToggle}
        />
      ) : (
        <ActionsSchemaPanel actionsSchema={connector.actions_schema} />
      )}
    </>
  );
}

function InteractivePairingPanel({
  connection,
  activeAuthRunId,
  onStart,
  onClear,
  onRecover,
  isStarting,
}: {
  connection: ConnectionItem;
  activeAuthRunId: number | null;
  onStart: () => void;
  onClear: () => void;
  onRecover: (runId: number) => void;
  isStarting: boolean;
}) {
  // On mount (or after reload), ask the API whether this connection already
  // has an in-flight auth run from the current user so we can resume rendering
  // its QR/artifact instead of showing "Pair device" again.
  const { data: activeLookup } = useActiveAuthRun(activeAuthRunId == null ? connection.id : null);
  useEffect(() => {
    const recoveredId = activeLookup?.run_id;
    if (activeAuthRunId == null && recoveredId) {
      onRecover(recoveredId);
    }
  }, [activeAuthRunId, activeLookup?.run_id, onRecover]);

  const { data: run, isLoading: isLoadingRun } = useAuthRun(activeAuthRunId);
  const isTerminal =
    run?.status === 'completed' || run?.status === 'failed' || run?.status === 'cancelled';

  const needsReauth =
    connection.status === 'pending_auth' ||
    connection.status === 'error' ||
    (connection.auth_profile_status != null && connection.auth_profile_status !== 'active');

  const hasActiveRun = activeAuthRunId != null && !isTerminal;

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <p className="text-xs text-muted-foreground">
        This connector pairs interactively (e.g. QR code or device link). Artifacts are only shown
        to the person who initiates the pairing.
      </p>

      {!hasActiveRun && (
        <Button
          type="button"
          variant={needsReauth ? 'default' : 'outline'}
          size="sm"
          className="h-8"
          disabled={isStarting}
          onClick={onStart}
        >
          {isStarting ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Starting…
            </>
          ) : needsReauth ? (
            'Pair device'
          ) : (
            'Reset pairing'
          )}
        </Button>
      )}

      {hasActiveRun && (
        <div className="space-y-3">
          {isLoadingRun && !run && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
            </div>
          )}

          {run && !run.artifact && !isTerminal && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Waiting for connector…
            </div>
          )}

          {run?.artifact && !isTerminal && activeAuthRunId != null && (
            <ArtifactRenderer artifact={run.artifact} runId={activeAuthRunId} />
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {run?.status === 'pending'
                ? 'Starting…'
                : run?.status === 'running'
                  ? 'Waiting for you…'
                  : ''}
            </span>
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={onClear}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isTerminal && run?.status === 'completed' && (
        <div className="text-sm text-emerald-600">Paired successfully.</div>
      )}
      {isTerminal && run?.status === 'failed' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
          {run.error_message || 'Authentication failed.'}
        </div>
      )}
    </div>
  );
}

interface ConnectionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  editingConnection?: ConnectionItem | null;
  connections?: ConnectionItem[];
  /** Auto-select this connector when the sheet opens (for new connection flow) */
  initialConnectorKey?: string;
}

export function ConnectionSheet({
  open,
  onOpenChange,
  organizationId,
  editingConnection,
  connections = [],
  initialConnectorKey,
}: ConnectionSheetProps) {
  const form = useConnectionForm({
    open,
    onOpenChange,
    organizationId,
    editingConnection,
    connections,
    initialConnectorKey,
  });
  const reauthenticate = useReauthenticateConnection();

  const getSheetTitle = () => {
    if (form.isEditMode) return 'Edit Connector';
    if (form.previewConnector) return 'Install Connector';
    return 'Add Connector';
  };

  const getSheetDescription = () => {
    if (form.previewConnector) return `Review ${form.previewConnector.name} before installing`;
    if (form.selectedConnector)
      return form.isEditMode
        ? `Edit ${form.selectedConnector.name} connector`
        : `Configure ${form.selectedConnector.name} connector`;
    if (form.isEditMode) return 'Loading connector details…';
    return 'Select a connector type to add';
  };

  return (
    <Sheet open={open} onOpenChange={form.handleOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{getSheetTitle()}</SheetTitle>
          <SheetDescription>{getSheetDescription()}</SheetDescription>
        </SheetHeader>

        <div className="py-6 space-y-6">
          {/* Connector Preview (uninstalled) */}
          {!form.selectedConnector && form.previewConnector && (
            <ConnectorPreview
              connector={form.previewConnector}
              onInstall={() => void form.handleInstallPreviewedConnector()}
              onBack={form.handleBack}
              isInstalling={form.installConnectorMutation.isPending}
              installError={form.installError}
            />
          )}

          {/* Connector Selection Grid */}
          {!form.selectedConnector && !form.previewConnector && (
            <div className="space-y-3">
              {form.isLoadingDefs ? (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading connectors...
                </div>
              ) : (
                <>
                  {/* Install Custom Connector */}
                  <div className="rounded-lg border border-dashed bg-card w-full">
                    {!form.showInstallForm ? (
                      <button
                        type="button"
                        className="flex items-center gap-3 p-3 w-full text-left text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => form.setShowInstallForm(true)}
                      >
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <Upload className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">Install Custom Connector</p>
                          <p className="text-xs text-muted-foreground">
                            Install from a source file URL or MCP server URL
                          </p>
                        </div>
                      </button>
                    ) : (
                      <div className="p-3 space-y-3">
                        <p className="text-sm font-medium">Install from URL</p>
                        <Input
                          placeholder="https://… (TypeScript source or MCP server URL)"
                          value={form.installSourceUrl}
                          onChange={(e) => {
                            form.setInstallSourceUrl(e.target.value);
                            form.setInstallError(null);
                          }}
                          className="text-xs font-mono"
                        />
                        <p className="text-xs text-muted-foreground">
                          URLs ending in .ts/.js are installed as source connectors. Other URLs are
                          probed as MCP servers.
                        </p>
                        {form.installError && (
                          <p className="text-xs text-destructive">{form.installError}</p>
                        )}
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              form.setShowInstallForm(false);
                              form.setInstallSourceUrl('');
                              form.setInstallError(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            disabled={
                              form.installConnectorMutation.isPending ||
                              !form.installSourceUrl.trim()
                            }
                            onClick={() => {
                              form.setInstallError(null);
                              const url = form.installSourceUrl.trim();
                              const isSourceUrl = /\.(ts|js|mjs)(\?|$)/i.test(url);
                              form.installConnectorMutation.mutate(
                                isSourceUrl ? { source_url: url } : { mcp_url: url },
                                {
                                  onSuccess: () => {
                                    form.setShowInstallForm(false);
                                    form.setInstallSourceUrl('');
                                  },
                                  onError: (error) => {
                                    form.setInstallError(
                                      error instanceof Error
                                        ? error.message
                                        : 'Failed to install connector'
                                    );
                                  },
                                }
                              );
                            }}
                          >
                            {form.installConnectorMutation.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : null}
                            Install
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Search */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search connectors..."
                      value={form.searchQuery}
                      onChange={(e) => form.setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  {!form.showInstallForm && form.installError && (
                    <p className="text-xs text-destructive">{form.installError}</p>
                  )}

                  {(() => {
                    const query = form.searchQuery.toLowerCase().trim();
                    const connectionCounts = new Map<string, number>();
                    for (const conn of connections) {
                      connectionCounts.set(
                        conn.connector_key,
                        (connectionCounts.get(conn.connector_key) ?? 0) + 1
                      );
                    }
                    const filtered = form.connectorDefs
                      .filter(
                        (c) =>
                          !query ||
                          c.name.toLowerCase().includes(query) ||
                          c.key.toLowerCase().includes(query) ||
                          c.description?.toLowerCase().includes(query)
                      )
                      .sort((a, b) => {
                        if (a.installed && !b.installed) return -1;
                        if (!a.installed && b.installed) return 1;
                        return a.name.localeCompare(b.name);
                      });
                    const renderConnector = (connector: ConnectorDefinitionItem) => {
                      const count = connectionCounts.get(connector.key) ?? 0;
                      const isInstalling =
                        form.installConnectorMutation.isPending &&
                        form.installingConnectorKey === connector.key;
                      return (
                        <button
                          key={connector.key}
                          type="button"
                          className="flex items-center gap-3 p-3 w-full text-left rounded-lg border bg-card hover:bg-accent/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                          onClick={() => void form.handleConnectorSelect(connector)}
                          disabled={
                            form.installConnectorMutation.isPending &&
                            form.installingConnectorKey !== connector.key
                          }
                        >
                          <div className="min-w-0 flex-1">
                            <ConnectorDisplay connector={connector} />
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            {connector.login_enabled && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0 gap-1"
                              >
                                <LogIn className="h-2.5 w-2.5" />
                                Login
                              </Badge>
                            )}
                            {isInstalling ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0 gap-1"
                              >
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                Installing
                              </Badge>
                            ) : count > 0 ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                              >
                                {count} conn.
                              </Badge>
                            ) : connector.installed ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                              >
                                Installed
                              </Badge>
                            ) : connector.installable ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                              >
                                Install
                              </Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0 text-muted-foreground"
                              >
                                Available
                              </Badge>
                            )}
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </button>
                      );
                    };

                    return (
                      <div className="space-y-2">
                        {filtered.map(renderConnector)}
                        {filtered.length === 0 && (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            No connectors match "{form.searchQuery}"
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {/* Connection Configuration Form */}
          {form.selectedConnector && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                {!form.isEditMode && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={form.handleBack}
                    className="h-7 px-2 text-xs"
                  >
                    &larr; Back
                  </Button>
                )}
                <ConnectorDisplay
                  connector={form.selectedConnector}
                  showDescription={false}
                  className="gap-2"
                />
                {form.selectedConnector.version && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                    v{form.selectedConnector.version}
                  </Badge>
                )}
              </div>

              {/* Pending auth banner */}
              {form.isEditMode &&
                editingConnection?.status === 'pending_auth' &&
                editingConnection.connect_token && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 space-y-3">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Authorization required
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      This connection is waiting for OAuth authorization to complete.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => {
                        const startUrl = `${API_URL}/connect/${editingConnection.connect_token}/oauth/start`;
                        form.navigateOAuthPopup(startUrl);
                      }}
                    >
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                      Authorize
                    </Button>
                  </div>
                )}

              {form.isEditMode &&
                editingConnection?.status === 'pending_auth' &&
                editingConnection.auth_profile_kind === 'browser_session' &&
                editingConnection.auth_profile_slug && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 space-y-3">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Browser auth required
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Capture or refresh the browser session for this auth profile, then the
                      connection will resume automatically.
                    </p>
                    <code className="block rounded bg-amber-100/80 dark:bg-amber-900/40 px-2 py-1.5 text-xs font-mono break-all">
                      owletto browser-auth --connector {editingConnection.connector_key}{' '}
                      --authProfileSlug {editingConnection.auth_profile_slug}
                    </code>
                  </div>
                )}

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="conn-display-name">
                  Display Name
                </label>
                <Input
                  id="conn-display-name"
                  placeholder={`e.g. Work ${form.selectedConnector.name}`}
                  value={form.displayName}
                  onChange={(e) => form.setDisplayName(e.target.value)}
                />
              </div>

              {/* Assign to member (admin only, create mode) */}
              {!form.isEditMode && form.isAdmin && (
                <div className="space-y-2">
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: label for custom MemberPicker component */}
                  <label className="text-sm font-medium">
                    Assign to Member{' '}
                    <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <MemberPicker
                    organizationId={organizationId}
                    value={form.selectedMemberUserId}
                    onValueChange={form.setSelectedMemberUserId}
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.selectedMemberUserId
                      ? 'Only the selected member will use this connection.'
                      : 'Leave empty to make this connection available to everyone in the organization.'}
                  </p>
                  {form.existingNoAuthConnection && (
                    <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        This user already has a {form.selectedConnector.name} connection. No-auth
                        connectors are limited to one per user.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Edit mode: executable actions via ActionRunner */}
              {form.isEditMode && editingConnection && form.selectedConnector.has_operations && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
                  <AutoApproveToggles connection={editingConnection} />
                  <ActionRunner connectionId={editingConnection.id} />
                </div>
              )}

              {/* Create mode: feeds & actions */}
              {!form.isEditMode && (
                <CreateModeCapabilities
                  connector={form.selectedConnector}
                  actionConfig={form.createActionConfig}
                  onActionConfigChange={form.setCreateActionConfig}
                />
              )}

              {/* Authentication */}
              {form.selectableMethods.length > 0 && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <p className="text-sm font-medium">Authentication</p>

                  {/* Method selector (only if >1 method) */}
                  {form.selectableMethods.length > 1 ? (
                    <div className="flex gap-2">
                      {form.selectableMethods.map((method, index) => (
                        <button
                          key={`${method.type}-${index}`}
                          type="button"
                          onClick={() => form.handleMethodChange(index)}
                          className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                            form.selectedAuthMethodIndex === index
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {getMethodLabel(method)}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {getMethodLabel(form.selectableMethods[0])}
                    </p>
                  )}

                  {form.activeMethod?.type !== 'none' && form.activeMethod?.description && (
                    <p className="text-xs text-muted-foreground">{form.activeMethod.description}</p>
                  )}

                  {form.activeMethod?.type === 'env_keys' && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Auth Profile</p>
                        <div className="flex gap-1.5">
                          <Select
                            value={form.selectedAuthProfileSlug}
                            onValueChange={form.setSelectedAuthProfileSlug}
                          >
                            <SelectTrigger className="h-8 flex-1 min-w-0">
                              <SelectValue placeholder="Select auth profile" />
                            </SelectTrigger>
                            <SelectContent>
                              {form.runtimeEnvProfiles.map((profile) => (
                                <SelectItem key={profile.slug} value={profile.slug}>
                                  {profile.display_name} ({profile.slug})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {form.selectedAuthProfileSlug &&
                            (form.confirmingDeleteProfileSlug === form.selectedAuthProfileSlug ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  disabled={form.deleteAuthProfileMutation.isPending}
                                  onClick={() =>
                                    void form.handleDeleteAuthProfile(
                                      form.selectedAuthProfileSlug!,
                                      'env'
                                    )
                                  }
                                >
                                  {form.deleteAuthProfileMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    'Delete'
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  onClick={() => form.setConfirmingDeleteProfileSlug(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  form.setConfirmingDeleteProfileSlug(form.selectedAuthProfileSlug!)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ))}
                        </div>
                        {form.runtimeEnvProfiles.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            No auth profiles yet for this connector.
                          </p>
                        )}
                      </div>

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => form.setShowNewRuntimeProfileForm((value) => !value)}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        {form.showNewRuntimeProfileForm
                          ? 'Hide New Profile'
                          : 'Create Auth Profile'}
                      </Button>

                      {form.showNewRuntimeProfileForm && (
                        <div className="space-y-3 rounded-md border bg-background p-3">
                          <Input
                            placeholder="Profile name"
                            value={form.newRuntimeProfileName}
                            onChange={(event) => form.setNewRuntimeProfileName(event.target.value)}
                          />
                          <Input
                            placeholder="profile-slug (optional)"
                            value={form.newRuntimeProfileSlug}
                            onChange={(event) => form.setNewRuntimeProfileSlug(event.target.value)}
                          />
                          {form.runtimeProfileSchema && (
                            <DynamicConnectorForm
                              schema={form.runtimeProfileSchema}
                              initialValues={undefined}
                              onValuesChange={form.setNewRuntimeProfileValues}
                              fieldIdPrefix="new-runtime-profile-"
                            />
                          )}
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                form.setShowNewRuntimeProfileForm(false);
                                form.setNewRuntimeProfileName('');
                                form.setNewRuntimeProfileSlug('');
                                form.setNewRuntimeProfileValues({});
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                form.createAuthProfile.isPending ||
                                Object.keys(
                                  form.normalizeStringValues(form.newRuntimeProfileValues)
                                ).length === 0
                              }
                              onClick={() => void form.handleCreateRuntimeProfile()}
                            >
                              {form.createAuthProfile.isPending ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              Create
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {form.activeMethod?.type === 'browser' && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          Browser Auth Profile
                        </p>
                        <div className="flex gap-1.5">
                          <Select
                            value={form.selectedAuthProfileSlug}
                            onValueChange={(value) => {
                              if (value === CREATE_BROWSER_PROFILE_VALUE) {
                                form.setShowNewBrowserProfileForm(true);
                                return;
                              }
                              form.setSelectedAuthProfileSlug(value);
                              form.setShowNewBrowserProfileForm(false);
                            }}
                          >
                            <SelectTrigger className="h-8 flex-1 min-w-0">
                              <SelectValue placeholder="Select browser auth profile" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={CREATE_BROWSER_PROFILE_VALUE}>
                                <Plus className="mr-1.5 inline h-3.5 w-3.5" />
                                Create new browser profile
                              </SelectItem>
                              {form.browserProfiles.map((profile) => (
                                <SelectItem key={profile.slug} value={profile.slug}>
                                  {profile.display_name} ({profile.slug})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {form.selectedAuthProfileSlug &&
                            (form.confirmingDeleteProfileSlug === form.selectedAuthProfileSlug ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  disabled={form.deleteAuthProfileMutation.isPending}
                                  onClick={() =>
                                    void form.handleDeleteAuthProfile(
                                      form.selectedAuthProfileSlug!,
                                      'browser'
                                    )
                                  }
                                >
                                  {form.deleteAuthProfileMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    'Delete'
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  onClick={() => form.setConfirmingDeleteProfileSlug(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  form.setConfirmingDeleteProfileSlug(form.selectedAuthProfileSlug!)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ))}
                        </div>
                        {form.browserProfiles.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            No browser auth profiles yet for this connector.
                          </p>
                        )}
                      </div>

                      {form.selectedAuthProfileSlug &&
                        (() => {
                          const profile = form.browserProfiles.find(
                            (p) => p.slug === form.selectedAuthProfileSlug
                          );
                          if (!profile) return null;
                          return (
                            <div className="space-y-2 rounded-md border bg-background p-3">
                              <div className="flex flex-wrap gap-2">
                                <Badge
                                  variant={profile.status === 'active' ? 'default' : 'secondary'}
                                >
                                  {profile.status}
                                </Badge>
                                {profile.auth_mode === 'cdp' && profile.cdp_url && (
                                  <Badge variant="outline">CDP: {profile.cdp_url}</Badge>
                                )}
                                {profile.auth_mode !== 'cdp' &&
                                  typeof profile.cookie_count === 'number' && (
                                    <Badge variant="outline">{profile.cookie_count} cookies</Badge>
                                  )}
                                {profile.auth_mode !== 'cdp' && profile.auth_cookie_name && (
                                  <Badge variant="outline">{profile.auth_cookie_name}</Badge>
                                )}
                              </div>
                              {profile.auth_mode === 'cdp' ? (
                                <p className="text-xs text-muted-foreground">
                                  This profile uses Chrome DevTools Protocol. Start Chrome with a
                                  classic remote-debugging endpoint, or leave the CDP URL on `auto`
                                  to probe local endpoints.
                                </p>
                              ) : (
                                <>
                                  <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
                                    owletto browser-auth --connector {form.selectedConnector.key}{' '}
                                    --authProfileSlug {profile.slug}
                                  </code>
                                  <code className="block rounded bg-muted px-2 py-1.5 text-xs font-mono break-all">
                                    owletto browser-auth --connector {form.selectedConnector.key}{' '}
                                    --authProfileSlug {profile.slug} --check
                                  </code>
                                </>
                              )}
                            </div>
                          );
                        })()}

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => form.setShowNewBrowserProfileForm((value) => !value)}
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        {form.showNewBrowserProfileForm
                          ? 'Hide New Profile'
                          : 'Create Browser Profile'}
                      </Button>

                      {form.showNewBrowserProfileForm && (
                        <div className="space-y-3 rounded-md border bg-background p-3">
                          <Input
                            placeholder="Profile name"
                            value={form.newBrowserProfileName}
                            onChange={(event) => form.setNewBrowserProfileName(event.target.value)}
                          />
                          <Input
                            placeholder="profile-slug (optional)"
                            value={form.newBrowserProfileSlug}
                            onChange={(event) => form.setNewBrowserProfileSlug(event.target.value)}
                          />
                          {form.activeMethod.capture === 'cdp' && (
                            <Input
                              placeholder="CDP URL (default: auto)"
                              value={form.newBrowserProfileCdpUrl}
                              onChange={(event) =>
                                form.setNewBrowserProfileCdpUrl(event.target.value)
                              }
                            />
                          )}
                          <p className="text-xs text-muted-foreground">
                            {form.activeMethod.capture === 'cdp'
                              ? 'Store a Chrome DevTools endpoint on this browser profile. Use `auto` to probe local Chrome remote-debugging endpoints.'
                              : 'Capture cookies after creating the profile with the CLI command shown above.'}
                          </p>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                form.setShowNewBrowserProfileForm(false);
                                form.setNewBrowserProfileName('');
                                form.setNewBrowserProfileSlug('');
                                form.setNewBrowserProfileCdpUrl(
                                  getBrowserMethodDefaultCdpUrl(form.activeMethod)
                                );
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              disabled={form.createAuthProfile.isPending}
                              onClick={() => void form.handleCreateBrowserProfile()}
                            >
                              {form.createAuthProfile.isPending ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : null}
                              Create
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {form.activeMethod?.type === 'interactive' &&
                    form.isEditMode &&
                    editingConnection &&
                    editingConnection.auth_profile_kind === 'interactive' && (
                      <InteractivePairingPanel
                        connection={editingConnection}
                        activeAuthRunId={form.pendingAuthRunId}
                        onStart={() => {
                          reauthenticate.mutate(editingConnection.id, {
                            onSuccess: (result) => {
                              form.setPendingAuthRunId(result.auth_run_id);
                            },
                          });
                        }}
                        onClear={() => form.setPendingAuthRunId(null)}
                        onRecover={(runId) => form.setPendingAuthRunId(runId)}
                        isStarting={reauthenticate.isPending}
                      />
                    )}

                  {form.activeMethod?.type === 'oauth' && (
                    <div className="space-y-4">
                      {/* OAuth App Profile — compact in create mode when already set up */}
                      {!form.isEditMode &&
                      form.appOAuthProfiles.length > 0 &&
                      form.selectedAppAuthProfileSlug ? (
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-muted-foreground">
                            OAuth App Profile
                          </p>
                          {form.appOAuthProfiles.length === 1 ? (
                            <p className="text-sm">{form.appOAuthProfiles[0].display_name}</p>
                          ) : (
                            <Select
                              value={form.selectedAppAuthProfileSlug}
                              onValueChange={form.setSelectedAppAuthProfileSlug}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {form.appOAuthProfiles.map((profile) => (
                                  <SelectItem key={profile.slug} value={profile.slug}>
                                    {profile.display_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">
                            OAuth App Profile
                          </p>
                          <div className="flex gap-1.5">
                            <Select
                              value={form.selectedAppAuthProfileSlug}
                              onValueChange={(value) => {
                                if (value === CREATE_OAUTH_APP_PROFILE_VALUE) {
                                  form.setShowNewAppProfileForm(true);
                                  return;
                                }
                                form.setSelectedAppAuthProfileSlug(value);
                                form.setShowNewAppProfileForm(false);
                              }}
                            >
                              <SelectTrigger className="h-8 flex-1 min-w-0">
                                <SelectValue
                                  placeholder={`Select ${(form.activeMethod as OAuthMethod).provider} app profile`}
                                />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={CREATE_OAUTH_APP_PROFILE_VALUE}>
                                  <Plus className="mr-1.5 inline h-3.5 w-3.5" />
                                  Create new app profile
                                </SelectItem>
                                {form.appOAuthProfiles.map((profile) => (
                                  <SelectItem key={profile.slug} value={profile.slug}>
                                    {profile.display_name} ({profile.slug})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {form.selectedAppAuthProfileSlug &&
                              (form.confirmingDeleteProfileSlug ===
                              form.selectedAppAuthProfileSlug ? (
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                    className="h-8 text-xs px-2"
                                    disabled={form.deleteAuthProfileMutation.isPending}
                                    onClick={() =>
                                      void form.handleDeleteAuthProfile(
                                        form.selectedAppAuthProfileSlug!,
                                        'app'
                                      )
                                    }
                                  >
                                    {form.deleteAuthProfileMutation.isPending ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      'Delete'
                                    )}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 text-xs px-2"
                                    onClick={() => form.setConfirmingDeleteProfileSlug(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                                  onClick={() =>
                                    form.setConfirmingDeleteProfileSlug(
                                      form.selectedAppAuthProfileSlug!
                                    )
                                  }
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ))}
                          </div>
                          {form.appOAuthProfiles.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              No OAuth app profiles yet — set up client credentials for this
                              connector.
                            </p>
                          )}
                          {form.showNewAppProfileForm && (
                            <div className="space-y-3 rounded-md border bg-background p-3">
                              <OAuthSetupInfo method={form.activeMethod as OAuthMethod} />
                              <Input
                                placeholder="App profile name"
                                value={form.newAppProfileName}
                                onChange={(event) => form.setNewAppProfileName(event.target.value)}
                              />
                              <Input
                                placeholder="app-profile-slug (optional)"
                                value={form.newAppProfileSlug}
                                onChange={(event) => form.setNewAppProfileSlug(event.target.value)}
                              />
                              {form.appProfileSchema && (
                                <DynamicConnectorForm
                                  schema={form.appProfileSchema}
                                  initialValues={undefined}
                                  onValuesChange={form.setNewAppProfileValues}
                                  fieldIdPrefix="new-app-profile-"
                                />
                              )}
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    form.setShowNewAppProfileForm(false);
                                    form.setNewAppProfileName('');
                                    form.setNewAppProfileSlug('');
                                    form.setNewAppProfileValues({});
                                  }}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={
                                    form.createAuthProfile.isPending ||
                                    Object.keys(
                                      form.normalizeStringValues(form.newAppProfileValues)
                                    ).length === 0
                                  }
                                  onClick={() => void form.handleCreateAppProfile()}
                                >
                                  {form.createAuthProfile.isPending ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : null}
                                  Create
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          OAuth Account Profile
                        </p>
                        <div className="flex gap-1.5">
                          <Select
                            value={form.selectedAuthProfileSlug}
                            onValueChange={(value) => {
                              if (value === CREATE_OAUTH_ACCOUNT_PROFILE_VALUE) {
                                form.setShowNewOAuthAccountForm(true);
                                return;
                              }
                              form.setSelectedAuthProfileSlug(value);
                              form.setShowNewOAuthAccountForm(false);
                            }}
                          >
                            <SelectTrigger className="h-8 flex-1 min-w-0">
                              <SelectValue
                                placeholder={`Select ${(form.activeMethod as OAuthMethod).provider} account profile`}
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={CREATE_OAUTH_ACCOUNT_PROFILE_VALUE}>
                                <Plus className="mr-1.5 inline h-3.5 w-3.5" />
                                Add new account
                              </SelectItem>
                              {form.runtimeOAuthProfiles.map((profile) => (
                                <SelectItem key={profile.slug} value={profile.slug}>
                                  {profile.display_name} ({profile.slug}) [{profile.status}]
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {form.selectedAuthProfileSlug &&
                            (form.confirmingDeleteProfileSlug === form.selectedAuthProfileSlug ? (
                              <div className="flex items-center gap-1 shrink-0">
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  disabled={form.deleteAuthProfileMutation.isPending}
                                  onClick={() =>
                                    void form.handleDeleteAuthProfile(
                                      form.selectedAuthProfileSlug!,
                                      'account'
                                    )
                                  }
                                >
                                  {form.deleteAuthProfileMutation.isPending ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    'Delete'
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-xs px-2"
                                  onClick={() => form.setConfirmingDeleteProfileSlug(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  form.setConfirmingDeleteProfileSlug(form.selectedAuthProfileSlug!)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ))}
                        </div>
                        {(() => {
                          const selectedProfile = form.runtimeOAuthProfiles.find(
                            (p) => p.slug === form.selectedAuthProfileSlug
                          );
                          return (
                            <div className="space-y-2">
                              <OAuthScopeSelector
                                requiredScopes={getRequiredOAuthScopes(
                                  form.activeMethod as OAuthMethod
                                )}
                                optionalScopes={form.availableOAuthOptionalScopes}
                                selectedOptionalScopes={form.selectedOAuthOptionalScopes}
                                grantedScopes={selectedProfile?.granted_scopes}
                                onToggleOptionalScope={(scope, checked) => {
                                  form.setSelectedOAuthOptionalScopes((current) =>
                                    checked
                                      ? [...new Set([...current, scope])]
                                      : current.filter((value) => value !== scope)
                                  );
                                }}
                              />
                              {selectedProfile ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-8"
                                  disabled={form.reconnectAuthProfile.isPending}
                                  onClick={() => void form.handleReconnect(selectedProfile.slug)}
                                >
                                  {form.reconnectAuthProfile.isPending ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <LogIn className="mr-1.5 h-3.5 w-3.5" />
                                  )}
                                  Connect
                                </Button>
                              ) : null}
                            </div>
                          );
                        })()}
                        {form.runtimeOAuthProfiles.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            No OAuth account profiles yet for this connector.
                          </p>
                        )}
                        {form.showNewOAuthAccountForm && (
                          <div className="space-y-3 rounded-md border bg-background p-3">
                            <Input
                              placeholder="Account profile name"
                              value={form.newOAuthAccountName}
                              onChange={(event) => form.setNewOAuthAccountName(event.target.value)}
                            />
                            <Input
                              placeholder="account-profile-slug (optional)"
                              value={form.newOAuthAccountSlug}
                              onChange={(event) => form.setNewOAuthAccountSlug(event.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                              Creating the profile will open the OAuth authorization page in a new
                              tab. When it finishes, the profile becomes reusable for future
                              connections.
                            </p>
                            <OAuthScopeSelector
                              requiredScopes={getRequiredOAuthScopes(
                                form.activeMethod as OAuthMethod
                              )}
                              optionalScopes={form.availableOAuthOptionalScopes}
                              selectedOptionalScopes={form.selectedOAuthOptionalScopes}
                              onToggleOptionalScope={(scope, checked) => {
                                form.setSelectedOAuthOptionalScopes((current) =>
                                  checked
                                    ? [...new Set([...current, scope])]
                                    : current.filter((value) => value !== scope)
                                );
                              }}
                            />
                            <div className="flex justify-end gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  form.setShowNewOAuthAccountForm(false);
                                  form.setNewOAuthAccountName('');
                                  form.setNewOAuthAccountSlug('');
                                }}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                disabled={form.createAuthProfile.isPending}
                                onClick={() => void form.handleCreateOAuthAccountProfile()}
                              >
                                {form.createAuthProfile.isPending ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                Continue
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Editable config form from options_schema */}
              {form.hasUniqueOptionsFields && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <p className="text-sm font-medium">Connection Options</p>
                  <DynamicConnectorForm
                    schema={form.selectedConnector.options_schema!}
                    initialValues={
                      form.isEditMode ? (editingConnection!.config ?? EMPTY_VALUES) : EMPTY_VALUES
                    }
                    onValuesChange={form.handleValuesChange}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer - Connection Save (not shown during preview) */}
        {form.selectedConnector && !form.previewConnector && (
          <SheetFooter className="border-t pt-4">
            {form.saveError && (
              <div className="w-full mb-3 rounded-md bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600 dark:text-red-400">
                {form.saveError}
              </div>
            )}
            <div className="flex items-center w-full">
              {form.isEditMode && (
                <div className="mr-auto">
                  {!form.showDeleteConfirm ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => form.setShowDeleteConfirm(true)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={form.deleteConnection.isPending}
                        onClick={() => {
                          form.deleteConnection.mutate(editingConnection!.id, {
                            onSuccess: () => form.handleOpenChange(false),
                          });
                        }}
                      >
                        {form.deleteConnection.isPending ? (
                          <>
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Deleting...
                          </>
                        ) : (
                          'Confirm'
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => form.setShowDeleteConfirm(false)}
                        disabled={form.deleteConnection.isPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <Button
                onClick={form.handleSave}
                disabled={form.isSaving || !!form.existingNoAuthConnection}
              >
                {form.isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {form.isEditMode ? 'Saving...' : 'Creating...'}
                  </>
                ) : form.isEditMode ? (
                  <>Save Changes</>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Connector
                  </>
                )}
              </Button>
            </div>
          </SheetFooter>
        )}
      </SheetContent>
      <AuthFlowDialog
        runId={form.activeMethod?.type === 'interactive' ? null : form.pendingAuthRunId}
        onClose={() => {
          form.setPendingAuthRunId(null);
          if (!form.isEditMode) {
            form.handleOpenChange(false);
          }
        }}
      />
    </Sheet>
  );
}
