import type {
  AuthArtifact,
  ConnectorAuthEnvField,
  ConnectorAuthMethod,
  ConnectorAuthSchema,
} from '@lobu/owletto-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL, fetchWithTimeout, resolveApiScope } from './core';
import { createMutation, createQuery } from './hook-factory';

// ============================================================
// Connections, Watchers, Contents, Templates - Global Data Views
// ============================================================

// Connection types (field names match DB columns which are not yet renamed)
export interface Source {
  crawler_id: number;
  entity_ids: number[];
  entity_name: string;
  entity_type: string;
  entity_slug: string;
  parent_id: number | null;
  parent_name: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  type: string;
  status: string;
  options: Record<string, unknown>;
  scoring_formula: string | null;
  url: string;
  display_label: string;
  last_crawl_at: string | null;
  last_crawl_status: string | null;
  last_error: string | null;
  next_crawl_at: string | null;
  crawl_count: number;
  consecutive_failures: number;
  created_at: string;
  content_count: number;
}

export interface SourceListResult {
  instances: Source[];
  metadata: {
    page_size: number;
    has_more: boolean;
    next_cursor?: string;
  };
}

// ============================================================
// Connector Types (for source discovery)
// ============================================================

export interface ConnectorTypeField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'array';
  required: boolean;
  description?: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
}

export type { ConnectorAuthEnvField, ConnectorAuthMethod, ConnectorAuthSchema };

export interface ConnectorType {
  type: string;
  name: string;
  description?: string;
  icon?: string;
  fields: ConnectorTypeField[];
  options_schema?: Record<string, unknown>;
  auth_schema?: ConnectorAuthSchema;
}

export interface UserCredential {
  id: number;
  userId: string;
  accountId: string;
  connectorKeys: string[];
  displayName: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  providerId: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: string | null;
}

export interface UserAccount {
  id: string;
  accountId: string | null;
  providerId: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: string | null;
  scope: string | null;
  createdAt: string;
}

// Uses fetchWithTimeout directly (REST endpoint, not tool-based)
export function useUserAccounts() {
  return useQuery({
    queryKey: ['user-accounts'],
    queryFn: async () => {
      const response = await fetchWithTimeout(`${API_URL}/api/accounts`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const result = (await response.json()) as { accounts?: UserAccount[] };
      return result.accounts ?? [];
    },
    staleTime: 30000,
  });
}

// =============================================================================
// V1 Integration Platform — Connections, Feeds, Runs
// =============================================================================

export interface ConnectionItem {
  id: number;
  organization_id: string;
  connector_key: string;
  display_name: string | null;
  status: string;
  config: Record<string, unknown> | null;
  error_message: string | null;
  created_by: string | null;
  created_by_username: string | null;
  created_at: string;
  updated_at: string;
  connector_name: string | null;
  auth_profile_slug: string | null;
  auth_profile_name: string | null;
  auth_profile_status: string | null;
  auth_profile_kind:
    | 'env'
    | 'oauth_app'
    | 'oauth_account'
    | 'browser_session'
    | 'interactive'
    | null;
  app_auth_profile_slug: string | null;
  app_auth_profile_name: string | null;
  app_auth_profile_status: string | null;
  app_auth_profile_kind:
    | 'env'
    | 'oauth_app'
    | 'oauth_account'
    | 'browser_session'
    | 'interactive'
    | null;
  event_count: number;
  feed_count: number;
  connect_token: string | null;
  entity_names: string | null;
  visibility: 'org' | 'private';
  operations_summary?: OperationSummary;
  has_operations?: boolean;
}

export interface OperationSummary {
  total: number;
  reads: number;
  writes: number;
  local_action: number;
  mcp_tool: number;
  http_operation: number;
}

export interface AuthProfileItem {
  id: number;
  organization_id: string;
  slug: string;
  display_name: string;
  connector_key: string;
  profile_kind: 'env' | 'oauth_app' | 'oauth_account' | 'browser_session';
  status: 'active' | 'pending_auth' | 'error' | 'revoked';
  provider: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  requested_scopes?: string[];
  granted_scopes?: string[];
  connect_url?: string;
  cookie_count?: number;
  captured_at?: string | null;
  auth_cookie_name?: string | null;
  expires_at?: string | null;
  is_expired?: boolean;
  has_auth_data?: boolean;
  auth_mode?: 'cdp' | 'cookies' | 'empty';
  cdp_url?: string | null;
}

export interface FeedItem {
  id: number;
  connection_id: number;
  display_name: string | null;
  feed_key: string;
  status: string;
  config: Record<string, unknown> | null;
  entity_ids: number[] | null;
  entity_names?: string | null;
  connector_key: string;
  connector_name: string | null;
  connection_name: string | null;
  connection_status: string | null;
  auth_profile_kind:
    | 'env'
    | 'oauth_app'
    | 'oauth_account'
    | 'browser_session'
    | 'interactive'
    | null;
  auth_profile_status: string | null;
  active_runs: number;
  event_count: number;
  last_sync_at: string | null;
  last_sync_status: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectorDefinitionItem {
  key: string;
  name: string;
  description: string | null;
  icon?: string | null;
  favicon_domain?: string | null;
  version: string;
  auth_schema: Record<string, unknown> | null;
  feeds_schema: Record<string, unknown> | null;
  actions_schema: Record<string, unknown> | null;
  options_schema: Record<string, unknown> | null;
  default_connection_config?: Record<string, unknown> | null;
  status: string;
  login_enabled: boolean;
  source_uri?: string | null;
  installed?: boolean;
  installable?: boolean;
  catalog_origin?: 'org' | 'catalog';
  operations_summary?: OperationSummary;
  has_operations?: boolean;
}

export interface AvailableOperationItem {
  connector_key: string;
  connector_name: string;
  operation_key: string;
  name: string;
  description?: string;
  kind: 'read' | 'write';
  backend: 'local_action' | 'mcp_tool' | 'http_operation';
  requires_approval: boolean;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface PublicConnectorDetailResult {
  connector: ConnectorDefinitionItem;
  feeds: FeedItem[];
}

export function usePublicConnectorDefinitions(
  orgSlug?: string | null,
  options?: { entityId?: number }
) {
  const entityId = options?.entityId;
  return useQuery({
    queryKey: ['public-connector-definitions', orgSlug, entityId],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const query = entityId ? `?entity_id=${entityId}` : '';
      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/connectors${query}`,
        {
          credentials: 'include',
        }
      );
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const result = (await response.json()) as {
        connector_definitions?: ConnectorDefinitionItem[];
      };
      return result.connector_definitions ?? [];
    },
    enabled: !!orgSlug,
    staleTime: 60000,
  });
}

export function usePublicConnectorDetail(orgSlug?: string | null, connectorKey?: string | null) {
  return useQuery({
    queryKey: ['public-connector-detail', orgSlug, connectorKey],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/connectors/${connectorKey}`,
        {
          credentials: 'include',
        }
      );
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      return (await response.json()) as PublicConnectorDetailResult;
    },
    enabled: !!orgSlug && !!connectorKey,
    staleTime: 30000,
  });
}

// ============================================================
// Query hooks
// ============================================================

export const useConnections = createQuery<
  [
    organizationId?: string | null,
    options?: {
      connectorKey?: string;
      status?: string;
      entityId?: number;
      createdBy?: string;
      limit?: number;
    },
  ],
  ConnectionItem[]
>({
  queryKey: (organizationId, options) => [
    'connections',
    organizationId,
    options?.connectorKey,
    options?.status,
    options?.entityId,
    options?.createdBy,
    options?.limit,
  ],
  tool: 'manage_connections',
  body: (_orgId, options) => ({
    action: 'list',
    connector_key: options?.connectorKey,
    status: options?.status,
    entity_id: options?.entityId,
    created_by: options?.createdBy,
    limit: options?.limit,
  }),
  transform: (r) => r.connections ?? [],
  enabled: (organizationId) => !!organizationId,
});

export const useConnectorDefinitions = createQuery<
  [organizationId?: string | null],
  ConnectorDefinitionItem[]
>({
  queryKey: (organizationId) => ['connector-definitions', organizationId],
  tool: 'manage_connections',
  body: () => ({
    action: 'list_connector_definitions',
  }),
  transform: (r) => r.connector_definitions ?? [],
  enabled: (organizationId) => !!organizationId,
  staleTime: 60000,
});

export const useInstallableConnectorCatalog = createQuery<
  [organizationId?: string | null],
  ConnectorDefinitionItem[]
>({
  queryKey: (organizationId) => ['connector-definitions', 'catalog', organizationId],
  tool: 'manage_connections',
  body: () => ({
    action: 'list_connector_definitions',
    include_installable: true,
  }),
  transform: (r) => r.connector_definitions ?? [],
  enabled: (organizationId) => !!organizationId,
  staleTime: 60000,
});

export const useAuthProfiles = createQuery<
  [
    organizationId?: string | null,
    options?: {
      connectorKey?: string;
      provider?: string;
      profileKind?: AuthProfileItem['profile_kind'];
    },
  ],
  AuthProfileItem[]
>({
  queryKey: (organizationId, options) => [
    'auth-profiles',
    organizationId,
    options?.connectorKey,
    options?.provider,
    options?.profileKind,
  ],
  tool: 'manage_auth_profiles',
  body: (_orgId, options) => ({
    action: 'list_auth_profiles',
    connector_key: options?.connectorKey,
    provider: options?.provider,
    profile_kind: options?.profileKind,
  }),
  transform: (r) => r.auth_profiles ?? [],
  enabled: (organizationId) => !!organizationId,
});

export const useFeeds = createQuery<[connectionId?: number | null], FeedItem[]>({
  queryKey: (connectionId) => ['feeds', connectionId],
  tool: 'manage_feeds',
  body: (connectionId) => ({ action: 'list_feeds', connection_id: connectionId }),
  transform: (r) => r.feeds ?? [],
  enabled: (connectionId) => !!connectionId,
});

export interface FeedRunItem {
  id: number;
  status: string;
  items_collected: number | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  checkpoint: Record<string, unknown> | null;
  connector_version: string | null;
}

export const useFeedDetail = createQuery<
  [feedId?: number | null],
  { feed: FeedItem; recent_runs: FeedRunItem[] }
>({
  queryKey: (feedId) => ['feed-detail', feedId],
  tool: 'manage_feeds',
  body: (feedId) => ({ action: 'get_feed', feed_id: feedId }),
  enabled: (feedId) => !!feedId,
});

export const useAllFeeds = createQuery<
  [organizationId?: string | null, options?: { entityId?: number; status?: string }],
  FeedItem[]
>({
  queryKey: (organizationId, options) => [
    'feeds',
    'all',
    organizationId,
    options?.entityId,
    options?.status,
  ],
  tool: 'manage_feeds',
  body: (_orgId, options) => ({
    action: 'list_feeds',
    entity_id: options?.entityId,
    status: options?.status,
  }),
  transform: (r) => r.feeds ?? [],
  enabled: (organizationId) => !!organizationId,
});

// ============================================================
// Mutation hooks
// ============================================================

export const useCreateConnection = createMutation<
  {
    connector_key: string;
    display_name?: string;
    auth_profile_slug?: string;
    app_auth_profile_slug?: string;
    config?: Record<string, unknown>;
    created_by?: string;
  },
  {
    action: 'create';
    connection: ConnectionItem;
    connector: ConnectorDefinitionItem;
    view_url?: string;
    auth_run_id?: number;
  }
>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'create', ...p }),
  invalidateKeys: ['connections'],
});

export interface ExecuteActionResult {
  run_id: number;
  status: 'completed' | 'failed' | 'pending_approval';
  output?: Record<string, unknown>;
  error_message?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export const useExecuteAction = createMutation<
  { connection_id: number; operation_key: string; input: Record<string, unknown> },
  ExecuteActionResult
>({
  tool: 'manage_operations',
  body: (p) => ({
    action: 'execute',
    connection_id: p.connection_id,
    operation_key: p.operation_key,
    input: p.input,
  }),
  invalidateKeys: ['connections', 'runs'],
  checkError: false,
});

export const useAvailableOperations = createQuery<
  [connectionId: number | null | undefined],
  AvailableOperationItem[]
>({
  queryKey: (connectionId) => ['available-operations', connectionId],
  tool: 'manage_operations',
  body: (connectionId) => ({
    action: 'list_available',
    connection_id: connectionId,
    include_input_schema: true,
    include_output_schema: true,
    limit: 1000,
    offset: 0,
  }),
  transform: (result) => result.operations ?? [],
  enabled: (connectionId) => !!connectionId,
  staleTime: 30000,
});

export const useConnectorOperations = createQuery<
  [connectorKey: string | null | undefined],
  AvailableOperationItem[]
>({
  queryKey: (connectorKey) => ['connector-operations', connectorKey],
  tool: 'manage_operations',
  body: (connectorKey) => ({
    action: 'list_available',
    connector_key: connectorKey,
    include_input_schema: false,
    include_output_schema: false,
    limit: 1000,
    offset: 0,
  }),
  transform: (result) => result.operations ?? [],
  enabled: (connectorKey) => !!connectorKey,
  staleTime: 30000,
});

export const useUpdateConnection = createMutation<{
  connection_id: number;
  display_name?: string;
  status?: string;
  auth_profile_slug?: string;
  app_auth_profile_slug?: string;
  config?: Record<string, unknown>;
}>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'update', ...p }),
  invalidateKeys: ['connections'],
});

export const useCreateAuthProfile = createMutation<
  {
    connector_key: string;
    profile_kind: AuthProfileItem['profile_kind'];
    display_name: string;
    slug?: string;
    credentials?: Record<string, string>;
    auth_data?: Record<string, unknown>;
    requested_scopes?: string[];
  },
  {
    auth_profile?: AuthProfileItem;
    pending_slug?: string;
    connect_url?: string;
    connect_token?: string;
  }
>({
  tool: 'manage_auth_profiles',
  body: (p) => ({ action: 'create_auth_profile', ...p }),
  invalidateKeys: ['auth-profiles', 'connector-definitions'],
});

export const useUpdateAuthProfile = createMutation<{
  auth_profile_slug: string;
  display_name?: string;
  slug?: string;
  credentials?: Record<string, string>;
  auth_data?: Record<string, unknown>;
  requested_scopes?: string[];
  status?: AuthProfileItem['status'];
}>({
  tool: 'manage_auth_profiles',
  body: (p) => ({ action: 'update_auth_profile', ...p }),
  invalidateKeys: ['auth-profiles', 'connections'],
});

export const useReconnectAuthProfile = createMutation<
  { auth_profile_slug: string; requested_scopes?: string[] },
  { auth_profile: AuthProfileItem; connect_url?: string }
>({
  tool: 'manage_auth_profiles',
  body: (params) => ({ action: 'update_auth_profile', ...params, reconnect: true }),
  invalidateKeys: ['auth-profiles'],
});

export const useDeleteAuthProfile = createMutation<string>({
  tool: 'manage_auth_profiles',
  body: (slug) => ({ action: 'delete_auth_profile', auth_profile_slug: slug }),
  invalidateKeys: ['auth-profiles', 'connections'],
  successMessage: 'Auth profile deleted',
});

export const useReauthenticateConnection = createMutation<
  number,
  { action: 'reauthenticate'; connection_id: number; auth_run_id: number }
>({
  tool: 'manage_connections',
  body: (connection_id) => ({ action: 'reauthenticate', connection_id }),
  invalidateKeys: ['connections'],
});

export const useDeleteConnection = createMutation<number>({
  tool: 'manage_connections',
  body: (id) => ({ action: 'delete', connection_id: id }),
  invalidateKeys: ['connections', 'feeds'],
  checkError: false,
  successMessage: 'Connection deleted',
});

export const useCreateFeed = createMutation<{
  connection_id: number;
  feed_key: string;
  display_name?: string;
  config?: Record<string, unknown>;
  entity_ids?: number[];
}>({
  tool: 'manage_feeds',
  body: (p) => ({ action: 'create_feed', ...p }),
  invalidateKeys: ['feeds'],
  successMessage: 'Feed created',
});

export const useUpdateFeed = createMutation<{
  feed_id: number;
  display_name?: string;
  config?: Record<string, unknown>;
  entity_ids?: number[];
  status?: string;
}>({
  tool: 'manage_feeds',
  body: (p) => ({ action: 'update_feed', ...p }),
  invalidateKeys: ['feeds'],
});

export const useDeleteFeed = createMutation<number>({
  tool: 'manage_feeds',
  body: (feedId) => ({ action: 'delete_feed', feed_id: feedId }),
  invalidateKeys: ['feeds'],
  successMessage: 'Feed deleted',
});

export const useTriggerFeed = createMutation<number>({
  tool: 'manage_feeds',
  body: (feedId) => ({ action: 'trigger_feed', feed_id: feedId }),
  invalidateKeys: ['feeds'],
});

// ============================================
// Action Approval
// ============================================

export const useApproveRun = createMutation<
  { run_id: number; input?: Record<string, unknown> },
  { approved: true; run_id: number; event_id?: number; message: string }
>({
  tool: 'manage_operations',
  body: (p) => ({ action: 'approve', ...p }),
  invalidateKeys: [
    'notifications',
    'notifications-unread-count',
    'contents-filtered',
    'contents-infinite',
    'public-contents-filtered',
    'public-contents-infinite',
  ],
  successMessage: 'Operation approved — executing',
});

export const useRejectRun = createMutation<
  { run_id: number; reason?: string },
  { rejected: true; run_id: number; event_id?: number }
>({
  tool: 'manage_operations',
  body: (p) => ({ action: 'reject', ...p }),
  invalidateKeys: [
    'notifications',
    'notifications-unread-count',
    'contents-filtered',
    'contents-infinite',
    'public-contents-filtered',
    'public-contents-infinite',
  ],
  successMessage: 'Operation rejected',
});

export const useUninstallConnector = createMutation<string>({
  tool: 'manage_connections',
  body: (key) => ({ action: 'uninstall_connector', connector_key: key }),
  invalidateKeys: ['connector-definitions'],
  successMessage: 'Connector uninstalled',
});

export const useInstallConnector = createMutation<{
  source_url?: string;
  source_uri?: string;
  source_code?: string;
  mcp_url?: string;
}>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'install_connector', ...p }),
  invalidateKeys: ['connector-definitions'],
});

export const useUpdateConnectorAuth = createMutation<{
  connector_key: string;
  auth_values: Record<string, string>;
}>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'update_connector_auth', ...p }),
  invalidateKeys: ['connector-definitions'],
});

export const useToggleConnectorLogin = createMutation<{
  connector_key: string;
  enabled: boolean;
}>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'toggle_connector_login', ...p }),
  invalidateKeys: ['connector-definitions', 'auth-config'],
});

export const useUpdateConnectorDefaultConfig = createMutation<{
  connector_key: string;
  default_connection_config: Record<string, unknown>;
}>({
  tool: 'manage_connections',
  body: (p) => ({ action: 'update_connector_default_config', ...p }),
  invalidateKeys: ['connector-definitions'],
});

// ============================================================
// Auth Runs (interactive connector.authenticate() lifecycle)
// ============================================================

export interface AuthRunStatus {
  id: number;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  connector_key: string | null;
  artifact: AuthArtifact | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  auth_profile: {
    id: number;
    slug: string | null;
    status: string | null;
  } | null;
}

export function useActiveAuthRun(connectionId: number | null | undefined) {
  return useQuery({
    queryKey: ['auth-run', 'active', connectionId],
    queryFn: async () => {
      const response = await fetchWithTimeout(
        `${API_URL}/api/auth-runs/active?connection_id=${connectionId}`,
        { credentials: 'include' }
      );
      if (!response.ok) {
        throw new Error(`Active auth run lookup failed: ${response.status}`);
      }
      return (await response.json()) as { run_id: number | null };
    },
    enabled: !!connectionId,
    staleTime: 0,
  });
}

export function useAuthRun(runId: number | null | undefined) {
  return useQuery({
    queryKey: ['auth-run', runId],
    queryFn: async () => {
      const response = await fetchWithTimeout(`${API_URL}/api/auth-runs/${runId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Auth run fetch failed: ${response.status}`);
      }
      return (await response.json()) as AuthRunStatus;
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const data = query.state.data as AuthRunStatus | undefined;
      if (!data) return 1000;
      const done = ['completed', 'failed', 'cancelled'].includes(data.status);
      return done ? false : 1000;
    },
  });
}

export function useSendAuthSignal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      run_id: number;
      name: string;
      payload?: Record<string, unknown>;
    }) => {
      const response = await fetchWithTimeout(`${API_URL}/api/auth-runs/${params.run_id}/signal`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: params.name, payload: params.payload ?? {} }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Signal failed: ${response.status}`);
      }
      return (await response.json()) as { success: true };
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['auth-run', vars.run_id] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to send signal');
    },
  });
}
