import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMembers } from '@/hooks/use-members';
import type { ConnectionItem, ConnectorDefinitionItem } from '@/lib/api';
import {
  useAuthProfiles,
  useCreateAuthProfile,
  useCreateConnection,
  useDeleteAuthProfile,
  useDeleteConnection,
  useInstallableConnectorCatalog,
  useInstallConnector,
  useReconnectAuthProfile,
  useUpdateConnection,
} from '@/lib/api';
import {
  buildEnvKeysSchema,
  buildInstallAuthSchemaForMethod,
  buildRequestedOAuthScopes,
  type EnvKeysMethod,
  getBrowserMethodDefaultCdpUrl,
  getOptionalOAuthScopes,
  getSelectableMethods,
  isCdpBrowserMethod,
  type OAuthMethod,
} from './auth-helpers';
import { useInstallableConnectorSelection } from './use-installable-connector-selection';

interface UseConnectionFormParams {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  editingConnection?: ConnectionItem | null;
  connections?: ConnectionItem[];
  initialConnectorKey?: string;
}

export function useConnectionForm({
  open,
  onOpenChange,
  organizationId,
  editingConnection,
  connections = [],
  initialConnectorKey,
}: UseConnectionFormParams) {
  const createConnection = useCreateConnection();
  const updateConnection = useUpdateConnection();
  const createAuthProfile = useCreateAuthProfile();
  const deleteAuthProfileMutation = useDeleteAuthProfile();
  const reconnectAuthProfile = useReconnectAuthProfile();
  const {
    data: connectorCatalog = [],
    isLoading: isLoadingDefs,
    refetch: refetchConnectorCatalog,
  } = useInstallableConnectorCatalog(organizationId);
  const isEditMode = !!editingConnection;
  const deleteConnection = useDeleteConnection();
  const installConnectorMutation = useInstallConnector();

  // Confirmation states
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmingDeleteProfileSlug, setConfirmingDeleteProfileSlug] = useState<string | null>(
    null
  );

  // Install custom connector state
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [installSourceUrl, setInstallSourceUrl] = useState('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Selection state
  const [selectedConnector, setSelectedConnector] = useState<ConnectorDefinitionItem | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [createActionConfig, setCreateActionConfig] = useState<Record<string, unknown>>({});
  const [selectedAuthMethodIndex, setSelectedAuthMethodIndex] = useState<number>(0);
  const [selectedAuthProfileSlug, setSelectedAuthProfileSlug] = useState<string | undefined>(
    undefined
  );
  const [selectedAppAuthProfileSlug, setSelectedAppAuthProfileSlug] = useState<string | undefined>(
    undefined
  );
  const [showNewRuntimeProfileForm, setShowNewRuntimeProfileForm] = useState(false);
  const [newRuntimeProfileName, setNewRuntimeProfileName] = useState('');
  const [newRuntimeProfileSlug, setNewRuntimeProfileSlug] = useState('');
  const [newRuntimeProfileValues, setNewRuntimeProfileValues] = useState<Record<string, unknown>>(
    {}
  );
  const [showNewAppProfileForm, setShowNewAppProfileForm] = useState(false);
  const [newAppProfileName, setNewAppProfileName] = useState('');
  const [newAppProfileSlug, setNewAppProfileSlug] = useState('');
  const [newAppProfileValues, setNewAppProfileValues] = useState<Record<string, unknown>>({});
  const [showNewOAuthAccountForm, setShowNewOAuthAccountForm] = useState(false);
  const [newOAuthAccountName, setNewOAuthAccountName] = useState('');
  const [newOAuthAccountSlug, setNewOAuthAccountSlug] = useState('');
  const [selectedOAuthOptionalScopes, setSelectedOAuthOptionalScopes] = useState<string[]>([]);
  const [showNewBrowserProfileForm, setShowNewBrowserProfileForm] = useState(false);
  const [newBrowserProfileName, setNewBrowserProfileName] = useState('');
  const [newBrowserProfileSlug, setNewBrowserProfileSlug] = useState('');
  const [newBrowserProfileCdpUrl, setNewBrowserProfileCdpUrl] = useState('auto');
  const [selectedMemberUserId, setSelectedMemberUserId] = useState<string | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingAuthRunId, setPendingAuthRunId] = useState<number | null>(null);
  const { isAdmin } = useMembers(organizationId);
  const oauthProvider = useMemo(() => {
    const methods = getSelectableMethods(selectedConnector?.auth_schema);
    const oauth = methods.find((m) => m.type === 'oauth') as OAuthMethod | undefined;
    return oauth?.provider ?? undefined;
  }, [selectedConnector?.auth_schema]);

  const { data: authProfiles = [], refetch: refetchAuthProfiles } = useAuthProfiles(
    organizationId,
    {
      connectorKey: selectedConnector?.key,
      provider: oauthProvider,
    }
  );

  // In edit mode, auto-select the connector and pre-fill form values
  useEffect(() => {
    if (!editingConnection || !open) return;
    if (selectedConnector) return;
    if (isLoadingDefs) return;

    const connector = connectorCatalog.find((c) => c.key === editingConnection.connector_key);

    const resolved: ConnectorDefinitionItem = connector ?? {
      key: editingConnection.connector_key,
      name: editingConnection.connector_name || editingConnection.connector_key,
      description: null,
      version: '',
      auth_schema: null,
      feeds_schema: null,
      actions_schema: null,
      options_schema: null,
      status: 'active',
      login_enabled: false,
    };

    setSelectedConnector(resolved);
    setDisplayName(editingConnection.display_name ?? '');
    setConfigValues(editingConnection.config ?? {});
    setSelectedAuthProfileSlug(editingConnection.auth_profile_slug ?? undefined);
    setSelectedAppAuthProfileSlug(editingConnection.app_auth_profile_slug ?? undefined);
    const authMethods = getSelectableMethods(resolved.auth_schema);
    const preferredMethodIndex = authMethods.findIndex((method) => {
      if (editingConnection.auth_profile_kind === 'browser_session')
        return method.type === 'browser';
      if (editingConnection.app_auth_profile_slug) return method.type === 'oauth';
      if (editingConnection.auth_profile_kind === 'env') return method.type === 'env_keys';
      return false;
    });
    setSelectedAuthMethodIndex(preferredMethodIndex >= 0 ? preferredMethodIndex : 0);
  }, [editingConnection, open, connectorCatalog, selectedConnector, isLoadingDefs]);

  // --- Auth for selected connector ---
  const selectableMethods = useMemo(
    () => getSelectableMethods(selectedConnector?.auth_schema),
    [selectedConnector]
  );
  const activeMethod = selectableMethods[selectedAuthMethodIndex] ?? null;
  const runtimeEnvProfiles = useMemo(
    () => authProfiles.filter((profile) => profile.profile_kind === 'env'),
    [authProfiles]
  );
  const runtimeOAuthProfiles = useMemo(() => {
    if (!activeMethod || activeMethod.type !== 'oauth') return [];
    const provider = activeMethod.provider.toLowerCase();
    return authProfiles.filter(
      (profile) =>
        profile.profile_kind === 'oauth_account' && profile.provider?.toLowerCase() === provider
    );
  }, [activeMethod, authProfiles]);
  const appOAuthProfiles = useMemo(() => {
    if (!activeMethod || activeMethod.type !== 'oauth') return [];
    const provider = activeMethod.provider.toLowerCase();
    return authProfiles.filter(
      (profile) =>
        profile.profile_kind === 'oauth_app' && profile.provider?.toLowerCase() === provider
    );
  }, [activeMethod, authProfiles]);
  const browserProfiles = useMemo(
    () => authProfiles.filter((profile) => profile.profile_kind === 'browser_session'),
    [authProfiles]
  );
  const runtimeProfileSchema = useMemo(() => {
    if (!activeMethod || activeMethod.type !== 'env_keys') return undefined;
    return buildEnvKeysSchema(activeMethod as EnvKeysMethod);
  }, [activeMethod]);
  const appProfileSchema = useMemo(
    () => buildInstallAuthSchemaForMethod(activeMethod),
    [activeMethod]
  );
  const availableOAuthOptionalScopes = useMemo(
    () => (activeMethod?.type === 'oauth' ? getOptionalOAuthScopes(activeMethod) : []),
    [activeMethod]
  );

  // Auto-select profiles in create mode when they become available
  useEffect(() => {
    if (isEditMode || !selectedConnector || !activeMethod) return;

    if (activeMethod.type === 'oauth') {
      if (!selectedAppAuthProfileSlug && appOAuthProfiles.length > 0) {
        setSelectedAppAuthProfileSlug(appOAuthProfiles[0].slug);
      }
      if (!selectedAuthProfileSlug && runtimeOAuthProfiles.length > 0) {
        setSelectedAuthProfileSlug(runtimeOAuthProfiles[0].slug);
      }
    } else if (activeMethod.type === 'env_keys') {
      if (!selectedAuthProfileSlug && runtimeEnvProfiles.length > 0) {
        setSelectedAuthProfileSlug(runtimeEnvProfiles[0].slug);
      }
    } else if (activeMethod.type === 'browser') {
      if (!selectedAuthProfileSlug && browserProfiles.length > 0) {
        setSelectedAuthProfileSlug(browserProfiles[0].slug);
      }
    }
  }, [
    isEditMode,
    selectedConnector,
    activeMethod,
    selectedAppAuthProfileSlug,
    selectedAuthProfileSlug,
    appOAuthProfiles,
    runtimeOAuthProfiles,
    runtimeEnvProfiles,
    browserProfiles,
  ]);

  useEffect(() => {
    if (activeMethod?.type !== 'oauth' || availableOAuthOptionalScopes.length === 0) {
      setSelectedOAuthOptionalScopes((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const selectedProfile = runtimeOAuthProfiles.find((p) => p.slug === selectedAuthProfileSlug);
    const requestedOptionalScopes = (selectedProfile?.requested_scopes ?? []).filter((scope) =>
      availableOAuthOptionalScopes.includes(scope)
    );
    setSelectedOAuthOptionalScopes((prev) => {
      if (
        prev.length === requestedOptionalScopes.length &&
        prev.every((s, i) => s === requestedOptionalScopes[i])
      ) {
        return prev;
      }
      return requestedOptionalScopes;
    });
  }, [activeMethod, availableOAuthOptionalScopes, runtimeOAuthProfiles, selectedAuthProfileSlug]);

  // --- Handlers ---

  const resetProfileForms = useCallback(() => {
    setShowNewRuntimeProfileForm(false);
    setNewRuntimeProfileName('');
    setNewRuntimeProfileSlug('');
    setNewRuntimeProfileValues({});
    setShowNewAppProfileForm(false);
    setNewAppProfileName('');
    setNewAppProfileSlug('');
    setNewAppProfileValues({});
    setShowNewOAuthAccountForm(false);
    setNewOAuthAccountName('');
    setNewOAuthAccountSlug('');
    setSelectedOAuthOptionalScopes([]);
    setShowNewBrowserProfileForm(false);
    setNewBrowserProfileName('');
    setNewBrowserProfileSlug('');
    setNewBrowserProfileCdpUrl('auto');
  }, []);

  const resetConnectorConfiguration = useCallback(() => {
    setConfigValues({});
    setCreateActionConfig({});
    setSelectedAuthMethodIndex(0);
    setSelectedAuthProfileSlug(undefined);
    setSelectedAppAuthProfileSlug(undefined);
    resetProfileForms();
  }, [resetProfileForms]);

  // Initialize createActionConfig from connector defaults when a connector is selected (create mode)
  useEffect(() => {
    if (isEditMode || !selectedConnector) return;
    const defaults = selectedConnector.default_connection_config;
    if (defaults && typeof defaults === 'object') {
      setCreateActionConfig(defaults);
    }
  }, [isEditMode, selectedConnector]);

  const reloadConnectorCatalog = useCallback(async () => {
    const refreshed = await refetchConnectorCatalog();
    return refreshed.data ?? [];
  }, [refetchConnectorCatalog]);

  const {
    installingConnectorKey,
    setInstallingConnectorKey,
    previewConnector,
    handleConnectorSelect,
    handleInstallPreviewedConnector,
    clearPreview,
  } = useInstallableConnectorSelection({
    isInstalling: installConnectorMutation.isPending,
    installConnectorFromSourceUri: async (sourceUri) => {
      await installConnectorMutation.mutateAsync({ source_uri: sourceUri });
    },
    reloadConnectorCatalog,
    resetConnectorConfiguration,
    selectConnector: setSelectedConnector,
    clearSaveError: () => setSaveError(null),
    setInstallError,
  });

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setSelectedConnector(null);
      setDisplayName('');
      resetConnectorConfiguration();
      setSelectedMemberUserId(undefined);
      setSaveError(null);
      setShowDeleteConfirm(false);
      setConfirmingDeleteProfileSlug(null);
      setShowInstallForm(false);
      setInstallSourceUrl('');
      setInstallError(null);
      setInstallingConnectorKey(null);
      setSearchQuery('');
      setPendingAuthRunId(null);
      clearPreview();
    }
    onOpenChange(newOpen);
  };

  const handleBack = () => {
    if (selectedConnector) {
      setSelectedConnector(null);
      resetConnectorConfiguration();
      setSelectedMemberUserId(undefined);
      setSaveError(null);
      setInstallError(null);
    } else if (previewConnector) {
      clearPreview();
    }
  };

  // Auto-select connector by key (for deep links like ?connector=x)
  const autoSelectedConnectorRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoSelectedConnectorRef.current = false;
      return;
    }
    if (autoSelectedConnectorRef.current || isEditMode || !initialConnectorKey || selectedConnector)
      return;
    const connector = connectorCatalog.find((c) => c.key === initialConnectorKey);
    if (connector) {
      autoSelectedConnectorRef.current = true;
      void handleConnectorSelect(connector);
    }
  }, [
    open,
    isEditMode,
    initialConnectorKey,
    connectorCatalog,
    selectedConnector,
    handleConnectorSelect,
  ]);

  // Compute whether options_schema has unique (non-feed-config) fields
  const hasUniqueOptionsFields = useMemo(() => {
    if (!selectedConnector?.options_schema) return false;
    const optionsProps = (
      selectedConnector.options_schema as { properties?: Record<string, unknown> }
    ).properties;
    if (!optionsProps) return false;

    const feedConfigProps = new Set<string>();
    const feedsSchema = selectedConnector.feeds_schema as Record<
      string,
      { configSchema?: { properties?: Record<string, unknown> } }
    > | null;
    if (feedsSchema) {
      for (const feedDef of Object.values(feedsSchema)) {
        if (feedDef.configSchema?.properties) {
          for (const propName of Object.keys(feedDef.configSchema.properties)) {
            feedConfigProps.add(propName);
          }
        }
      }
    }

    return Object.keys(optionsProps).some((key) => !feedConfigProps.has(key));
  }, [selectedConnector]);

  const isNoAuthConnector = useMemo(() => {
    const methods = getSelectableMethods(selectedConnector?.auth_schema);
    const allMethods =
      (selectedConnector?.auth_schema as { methods?: Array<{ type: string }> })?.methods ?? [];
    return (
      methods.length === 0 && allMethods.length > 0 && allMethods.every((m) => m.type === 'none')
    );
  }, [selectedConnector]);

  const existingNoAuthConnection = useMemo(() => {
    if (!isNoAuthConnector || !selectedConnector || !selectedMemberUserId) return null;
    return (
      connections.find(
        (c) => c.connector_key === selectedConnector.key && c.created_by === selectedMemberUserId
      ) ?? null
    );
  }, [isNoAuthConnector, selectedConnector, selectedMemberUserId, connections]);

  const handleValuesChange = useCallback((values: Record<string, unknown>) => {
    setConfigValues(values);
  }, []);

  const normalizeStringValues = useCallback((values: Record<string, unknown>) => {
    return Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
        .map(([key, value]) => [key, String(value).trim()])
    );
  }, []);

  /**
   * Navigate a popup to the OAuth start URL and poll for completion.
   */
  const navigateOAuthPopup = useCallback(
    (connectUrl: string, popup?: Window | null) => {
      const oauthStartUrl = connectUrl.endsWith('/oauth/start')
        ? connectUrl
        : `${connectUrl}/oauth/start`;

      const win = popup ?? window.open(oauthStartUrl, '_blank', 'noopener,noreferrer');
      if (popup) {
        popup.location.href = oauthStartUrl;
      }

      const refreshProfiles = () => {
        void refetchAuthProfiles();
        window.removeEventListener('focus', refreshProfiles);
      };
      window.addEventListener('focus', refreshProfiles);

      if (win) {
        const interval = window.setInterval(() => {
          if (win.closed) {
            window.clearInterval(interval);
            refreshProfiles();
          }
        }, 500);
      }
    },
    [refetchAuthProfiles]
  );

  const handleCreateProfile = useCallback(
    async (params: {
      profileKind: 'env' | 'oauth_app' | 'oauth_account' | 'browser_session';
      displayName: string;
      slug: string;
      credentials?: Record<string, string>;
      authData?: Record<string, unknown>;
      requestedScopes?: string[];
      onSuccess: (result: {
        auth_profile?: { slug: string };
        pending_slug?: string;
        connect_url?: string;
      }) => void | Promise<void>;
    }) => {
      if (!selectedConnector || !activeMethod) return;
      try {
        const result = await createAuthProfile.mutateAsync({
          connector_key: selectedConnector.key,
          profile_kind: params.profileKind,
          display_name: params.displayName,
          slug: params.slug || undefined,
          ...(params.credentials ? { credentials: params.credentials } : {}),
          ...(params.authData ? { auth_data: params.authData } : {}),
          ...(params.requestedScopes ? { requested_scopes: params.requestedScopes } : {}),
        });
        await params.onSuccess(result);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'Failed to create auth profile');
      }
    },
    [activeMethod, createAuthProfile, selectedConnector]
  );

  const handleCreateRuntimeProfile = useCallback(async () => {
    if (!activeMethod || activeMethod.type !== 'env_keys') return;
    const credentials = normalizeStringValues(newRuntimeProfileValues);
    await handleCreateProfile({
      profileKind: 'env',
      displayName: newRuntimeProfileName.trim() || `${selectedConnector?.name} Auth`,
      slug: newRuntimeProfileSlug.trim(),
      credentials,
      onSuccess: (result) => {
        setSelectedAuthProfileSlug(result.auth_profile!.slug);
        setShowNewRuntimeProfileForm(false);
        setNewRuntimeProfileName('');
        setNewRuntimeProfileSlug('');
        setNewRuntimeProfileValues({});
      },
    });
  }, [
    activeMethod,
    handleCreateProfile,
    newRuntimeProfileName,
    newRuntimeProfileSlug,
    newRuntimeProfileValues,
    normalizeStringValues,
    selectedConnector?.name,
  ]);

  const handleCreateAppProfile = useCallback(async () => {
    if (!activeMethod || activeMethod.type !== 'oauth') return;
    const credentials = normalizeStringValues(newAppProfileValues);
    await handleCreateProfile({
      profileKind: 'oauth_app',
      displayName:
        newAppProfileName.trim() || `${selectedConnector?.name} ${activeMethod.provider} App`,
      slug: newAppProfileSlug.trim(),
      credentials,
      onSuccess: (result) => {
        setSelectedAppAuthProfileSlug(result.auth_profile!.slug);
        setShowNewAppProfileForm(false);
        setNewAppProfileName('');
        setNewAppProfileSlug('');
        setNewAppProfileValues({});
      },
    });
  }, [
    activeMethod,
    handleCreateProfile,
    newAppProfileName,
    newAppProfileSlug,
    newAppProfileValues,
    normalizeStringValues,
    selectedConnector?.name,
  ]);

  const handleCreateOAuthAccountProfile = useCallback(async () => {
    if (!activeMethod || activeMethod.type !== 'oauth') return;
    setSaveError(null);
    // Open popup synchronously to avoid browser popup blocker
    const popup = window.open('about:blank', '_blank');
    await handleCreateProfile({
      profileKind: 'oauth_account',
      displayName:
        newOAuthAccountName.trim() || `${selectedConnector?.name} ${activeMethod.provider} Account`,
      slug: newOAuthAccountSlug.trim(),
      requestedScopes: buildRequestedOAuthScopes(activeMethod, selectedOAuthOptionalScopes),
      onSuccess: async (result) => {
        const slug = result.auth_profile?.slug ?? result.pending_slug;
        if (slug) setSelectedAuthProfileSlug(slug);
        setShowNewOAuthAccountForm(false);
        setNewOAuthAccountName('');
        setNewOAuthAccountSlug('');
        if (result.connect_url) {
          navigateOAuthPopup(result.connect_url, popup);
        } else {
          popup?.close();
        }
      },
    });
  }, [
    activeMethod,
    handleCreateProfile,
    navigateOAuthPopup,
    newOAuthAccountName,
    newOAuthAccountSlug,
    selectedConnector?.name,
    selectedOAuthOptionalScopes,
  ]);

  const handleCreateBrowserProfile = useCallback(async () => {
    if (!activeMethod || activeMethod.type !== 'browser') return;
    await handleCreateProfile({
      profileKind: 'browser_session',
      displayName:
        newBrowserProfileName.trim() || `${selectedConnector?.name || 'Connector'} Browser Session`,
      slug: newBrowserProfileSlug.trim(),
      authData:
        activeMethod.capture === 'cdp'
          ? { cdp_url: newBrowserProfileCdpUrl.trim() || activeMethod.defaultCdpUrl || 'auto' }
          : undefined,
      onSuccess: (result) => {
        if (result.auth_profile?.slug) {
          setSelectedAuthProfileSlug(result.auth_profile.slug);
        }
        setShowNewBrowserProfileForm(false);
        setNewBrowserProfileName('');
        setNewBrowserProfileSlug('');
        setNewBrowserProfileCdpUrl(activeMethod.defaultCdpUrl || 'auto');
      },
    });
  }, [
    activeMethod,
    handleCreateProfile,
    newBrowserProfileCdpUrl,
    newBrowserProfileName,
    newBrowserProfileSlug,
    selectedConnector?.name,
  ]);

  const handleSave = async () => {
    if (!selectedConnector) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const config: Record<string, unknown> = { ...configValues, ...createActionConfig };
      let authProfileSlug: string | null | undefined;
      let appAuthProfileSlug: string | null | undefined;

      if (activeMethod?.type === 'env_keys') {
        authProfileSlug = selectedAuthProfileSlug?.trim() || undefined;
        if (!authProfileSlug) {
          throw new Error('Select or create an auth profile before creating the connection.');
        }
      }

      if (activeMethod?.type === 'oauth') {
        authProfileSlug = selectedAuthProfileSlug?.trim() || undefined;
        appAuthProfileSlug = selectedAppAuthProfileSlug?.trim() || undefined;

        if (!appAuthProfileSlug) {
          throw new Error(
            `Select or create an ${(activeMethod as OAuthMethod).provider} app profile first.`
          );
        }
        if (!authProfileSlug) {
          throw new Error(
            `Select or create an ${(activeMethod as OAuthMethod).provider} account profile first.`
          );
        }
      }

      if (activeMethod?.type === 'browser') {
        authProfileSlug = selectedAuthProfileSlug?.trim() || undefined;
        if (!authProfileSlug) {
          throw new Error(
            'Select or create a browser auth profile before creating the connection.'
          );
        }
      }

      if (isEditMode) {
        await updateConnection.mutateAsync({
          connection_id: editingConnection.id,
          display_name: displayName || undefined,
          auth_profile_slug:
            activeMethod?.type === 'oauth' ||
            activeMethod?.type === 'env_keys' ||
            activeMethod?.type === 'browser'
              ? (authProfileSlug ?? undefined)
              : undefined,
          app_auth_profile_slug:
            activeMethod?.type === 'oauth' ? (appAuthProfileSlug ?? undefined) : undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
        });
        handleOpenChange(false);
      } else {
        const result = await createConnection.mutateAsync({
          connector_key: selectedConnector.key,
          display_name: displayName || undefined,
          auth_profile_slug: authProfileSlug ?? undefined,
          app_auth_profile_slug: appAuthProfileSlug ?? undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
          created_by: selectedMemberUserId,
        });
        if (result.auth_run_id) {
          setPendingAuthRunId(result.auth_run_id);
        } else {
          handleOpenChange(false);
        }
      }
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : isEditMode
            ? 'Failed to update connection'
            : 'Failed to create connection'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleMethodChange = (index: number) => {
    setSelectedAuthMethodIndex(index);
    setSelectedAuthProfileSlug(undefined);
    setSelectedAppAuthProfileSlug(undefined);
    setShowNewRuntimeProfileForm(false);
    setShowNewAppProfileForm(false);
    setShowNewOAuthAccountForm(false);
    setShowNewBrowserProfileForm(false);
    setNewRuntimeProfileValues({});
    setNewAppProfileValues({});
    setSelectedOAuthOptionalScopes([]);
    setNewBrowserProfileCdpUrl(
      isCdpBrowserMethod(selectableMethods[index])
        ? getBrowserMethodDefaultCdpUrl(selectableMethods[index])
        : 'auto'
    );
  };

  const handleDeleteAuthProfile = async (
    slug: string,
    kind: 'env' | 'app' | 'account' | 'browser'
  ) => {
    try {
      await deleteAuthProfileMutation.mutateAsync(slug);
      setConfirmingDeleteProfileSlug(null);
      if (kind === 'app') {
        setSelectedAppAuthProfileSlug('');
      } else {
        setSelectedAuthProfileSlug('');
      }
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : `Failed to delete ${kind === 'app' ? 'app' : 'auth'} profile`
      );
    }
  };

  const handleReconnect = async (profileSlug: string) => {
    const popup = window.open('about:blank', '_blank');
    try {
      const result = await reconnectAuthProfile.mutateAsync({
        auth_profile_slug: profileSlug,
        requested_scopes: buildRequestedOAuthScopes(
          activeMethod?.type === 'oauth' ? activeMethod : null,
          selectedOAuthOptionalScopes
        ),
      });
      if (result.connect_url) {
        navigateOAuthPopup(result.connect_url, popup);
      } else {
        popup?.close();
      }
    } catch (error) {
      popup?.close();
      setSaveError(error instanceof Error ? error.message : 'Failed to reconnect');
    }
  };

  return {
    // Mutations
    createAuthProfile,
    deleteAuthProfileMutation,
    reconnectAuthProfile,
    deleteConnection,
    installConnectorMutation,

    // Connector definitions
    connectorDefs: connectorCatalog,
    isLoadingDefs,
    isEditMode,

    // Confirmation states
    showDeleteConfirm,
    setShowDeleteConfirm,
    confirmingDeleteProfileSlug,
    setConfirmingDeleteProfileSlug,

    // Install form
    showInstallForm,
    setShowInstallForm,
    installSourceUrl,
    setInstallSourceUrl,
    installError,
    setInstallError,
    installingConnectorKey,
    searchQuery,
    setSearchQuery,

    // Preview
    previewConnector,
    handleInstallPreviewedConnector,
    clearPreview,

    // Selection state
    selectedConnector,
    displayName,
    setDisplayName,
    configValues,
    createActionConfig,
    setCreateActionConfig,
    selectedAuthMethodIndex,
    selectedAuthProfileSlug,
    setSelectedAuthProfileSlug,
    selectedAppAuthProfileSlug,
    setSelectedAppAuthProfileSlug,
    showNewRuntimeProfileForm,
    setShowNewRuntimeProfileForm,
    newRuntimeProfileName,
    setNewRuntimeProfileName,
    newRuntimeProfileSlug,
    setNewRuntimeProfileSlug,
    newRuntimeProfileValues,
    setNewRuntimeProfileValues,
    showNewAppProfileForm,
    setShowNewAppProfileForm,
    newAppProfileName,
    setNewAppProfileName,
    newAppProfileSlug,
    setNewAppProfileSlug,
    newAppProfileValues,
    setNewAppProfileValues,
    showNewOAuthAccountForm,
    setShowNewOAuthAccountForm,
    newOAuthAccountName,
    setNewOAuthAccountName,
    newOAuthAccountSlug,
    setNewOAuthAccountSlug,
    showNewBrowserProfileForm,
    setShowNewBrowserProfileForm,
    newBrowserProfileName,
    setNewBrowserProfileName,
    newBrowserProfileSlug,
    setNewBrowserProfileSlug,
    newBrowserProfileCdpUrl,
    setNewBrowserProfileCdpUrl,
    isSaving,
    saveError,
    setSaveError,
    pendingAuthRunId,
    setPendingAuthRunId,

    // Auth profiles
    authProfiles,

    // Derived auth state
    selectableMethods,
    activeMethod,
    runtimeEnvProfiles,
    runtimeOAuthProfiles,
    appOAuthProfiles,
    browserProfiles,
    runtimeProfileSchema,
    appProfileSchema,
    availableOAuthOptionalScopes,
    selectedOAuthOptionalScopes,
    setSelectedOAuthOptionalScopes,

    // Computed
    hasUniqueOptionsFields,
    connections,
    isNoAuthConnector,
    existingNoAuthConnection,

    // Member picker (admin only)
    selectedMemberUserId,
    setSelectedMemberUserId,
    isAdmin,

    // Handlers
    handleOpenChange,
    handleConnectorSelect,
    handleBack,
    handleValuesChange,
    normalizeStringValues,
    navigateOAuthPopup,
    handleCreateRuntimeProfile,
    handleCreateAppProfile,
    handleCreateOAuthAccountProfile,
    handleCreateBrowserProfile,
    handleSave,
    handleMethodChange,
    handleDeleteAuthProfile,
    handleReconnect,
  };
}
