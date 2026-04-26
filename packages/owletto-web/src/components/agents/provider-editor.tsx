import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type AgentAuthProfile,
  type AgentAuthType,
  type AgentProviderCatalogItem,
  type AgentProviderDeviceCodeStartResponse,
  getAgentProviderOAuthStartUrl,
  pollAgentProviderDeviceCode,
  startAgentProviderDeviceCode,
  submitAgentProviderOAuthCode,
} from '@/lib/api';

export type ProviderEditorRow = {
  providerId: string;
  authType: AgentAuthType;
  credential: string;
  modelPreference: string;
  existingProfile?: AgentAuthProfile;
};

export type ProviderDeviceCodeState = AgentProviderDeviceCodeStartResponse & {
  status: 'idle' | 'pending' | 'success' | 'error';
  message?: string;
};

export const AUTO_MODEL_VALUE = '__auto__';

export function getProviderName(providerId: string, catalog: AgentProviderCatalogItem[]): string {
  return catalog.find((provider) => provider.providerId === providerId)?.name ?? providerId;
}

export function buildProviderRows(
  settings:
    | {
        authProfiles?: AgentAuthProfile[];
        installedProviders?: Array<{ providerId: string }>;
        providerModelPreferences?: Record<string, string>;
      }
    | null
    | undefined,
  catalog: AgentProviderCatalogItem[]
): ProviderEditorRow[] {
  const installedOrder = (settings?.installedProviders ?? []).map(
    (provider) => provider.providerId
  );
  const profileByProvider = new Map<string, AgentAuthProfile>();
  for (const profile of settings?.authProfiles ?? []) {
    if (!profileByProvider.has(profile.provider)) {
      profileByProvider.set(profile.provider, profile);
    }
  }

  const orderedProviderIds = [...installedOrder];
  for (const providerId of profileByProvider.keys()) {
    if (!orderedProviderIds.includes(providerId)) {
      orderedProviderIds.push(providerId);
    }
  }

  return orderedProviderIds.map((providerId) => {
    const existingProfile = profileByProvider.get(providerId);
    const providerMeta = catalog.find((provider) => provider.providerId === providerId);

    return {
      providerId,
      authType: existingProfile?.authType ?? providerMeta?.authType ?? 'api-key',
      credential: '',
      modelPreference: settings?.providerModelPreferences?.[providerId] ?? '',
      existingProfile,
    };
  });
}

export function buildProviderLabel(
  providerName: string,
  authType: AgentAuthType,
  credential: string,
  previousLabel?: string
): string {
  if (previousLabel?.trim()) return previousLabel.trim();
  if (!credential) return `${providerName} (${authType})`;
  if (credential.length <= 8) return `${providerName} (${authType})`;
  return `${providerName} ${credential.slice(0, 4)}...${credential.slice(-4)}`;
}

function getCredentialPlaceholder(
  provider: AgentProviderCatalogItem | undefined,
  authType: AgentAuthType
): string {
  if (authType === 'api-key') {
    return provider?.apiKeyPlaceholder || 'Paste API key';
  }
  if (authType === 'oauth') {
    return 'Paste code#state from Claude';
  }
  return 'Use the generated device code below';
}

function getProviderInstructions(
  provider: AgentProviderCatalogItem | undefined,
  authType: AgentAuthType
): string | null {
  if (authType === 'api-key' && provider?.apiKeyInstructions) {
    return provider.apiKeyInstructions.replace(/<[^>]+>/g, '');
  }
  if (provider?.systemAvailable) {
    return 'This provider also has a system credential available if you leave the credential blank.';
  }
  return null;
}

function getAuthTabLabel(
  provider: AgentProviderCatalogItem | undefined,
  authType: AgentAuthType
): string {
  if (authType === 'oauth') {
    return provider?.providerId === 'claude' ? 'Claude Login' : 'OAuth';
  }
  if (authType === 'device-code') return 'Device Code';
  return 'API Key';
}

function getConnectedCopy(
  profile: AgentAuthProfile | undefined,
  authType: AgentAuthType
): string | null {
  if (!profile || profile.authType !== authType) return null;
  if (authType === 'oauth') return 'Connected with Claude login.';
  if (authType === 'device-code') {
    return profile.metadata?.accountId
      ? `Connected to ChatGPT account ${profile.metadata.accountId}.`
      : 'Connected with ChatGPT device code.';
  }
  return 'API key already saved. Enter a new key only if you want to replace it.';
}

export function canConfigureProviderModel(
  row: ProviderEditorRow,
  provider: AgentProviderCatalogItem | undefined
): boolean {
  if (row.credential.trim()) return true;
  if (provider?.systemAvailable) return true;
  return row.existingProfile?.authType === row.authType;
}

interface ProviderEditorSectionProps {
  agentId: string;
  slug: string;
  providerRows: ProviderEditorRow[];
  setProviderRows: React.Dispatch<React.SetStateAction<ProviderEditorRow[]>>;
  catalog: AgentProviderCatalogItem[];
  models: Record<string, Array<{ value: string; label: string }>>;
  isLoading: boolean;
  isPending: boolean;
}

export function ProviderEditorSection({
  agentId,
  slug,
  providerRows,
  setProviderRows,
  catalog,
  models,
  isLoading,
  isPending,
}: ProviderEditorSectionProps) {
  const queryClient = useQueryClient();
  const [showProviderPicker, setShowProviderPicker] = useState(false);
  const [oauthCodeDrafts, setOauthCodeDrafts] = useState<Record<string, string>>({});
  const [deviceCodeStates, setDeviceCodeStates] = useState<Record<string, ProviderDeviceCodeState>>(
    {}
  );
  const [authActionState, setAuthActionState] = useState<Record<string, string>>({});

  const availableProviders = catalog.filter(
    (provider) => !providerRows.some((row) => row.providerId === provider.providerId)
  );

  useEffect(() => {
    if (!availableProviders.length && showProviderPicker) {
      setShowProviderPicker(false);
    }
  }, [availableProviders.length, showProviderPicker]);

  const updateProviderRow = useCallback(
    (providerId: string, updates: Partial<ProviderEditorRow>) => {
      setProviderRows((current) =>
        current.map((row) => (row.providerId === providerId ? { ...row, ...updates } : row))
      );
    },
    [setProviderRows]
  );

  const moveProvider = useCallback(
    (providerId: string, direction: -1 | 1) => {
      setProviderRows((current) => {
        const index = current.findIndex((row) => row.providerId === providerId);
        if (index < 0) return current;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= current.length) return current;
        const next = [...current];
        const [row] = next.splice(index, 1);
        next.splice(nextIndex, 0, row);
        return next;
      });
    },
    [setProviderRows]
  );

  const removeProvider = useCallback(
    (providerId: string) => {
      setProviderRows((current) => current.filter((row) => row.providerId !== providerId));
    },
    [setProviderRows]
  );

  const addProvider = useCallback(
    (providerId: string) => {
      if (!providerId) return;
      const provider = catalog.find((entry) => entry.providerId === providerId);
      if (!provider) return;
      setProviderRows((current) => {
        if (current.some((row) => row.providerId === provider.providerId)) {
          return current;
        }
        return [
          ...current,
          {
            providerId: provider.providerId,
            authType: provider.authType,
            credential: '',
            modelPreference: '',
          },
        ];
      });
      setShowProviderPicker(false);
    },
    [catalog, setProviderRows]
  );

  const setAuthDraft = useCallback((providerId: string, value: string) => {
    setOauthCodeDrafts((current) => ({ ...current, [providerId]: value }));
  }, []);

  const setAuthStateMessage = useCallback((key: string, value: string) => {
    setAuthActionState((current) => ({ ...current, [key]: value }));
  }, []);

  const refreshProviderAuthState = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['agent-config'] }).catch(() => undefined),
      queryClient
        .invalidateQueries({ queryKey: ['agent-provider-catalog'] })
        .catch(() => undefined),
      queryClient.invalidateQueries({ queryKey: ['agent'] }).catch(() => undefined),
    ]);
  }, [queryClient]);

  const handleClaudeOAuthSubmit = useCallback(
    async (providerId: string) => {
      const draft = oauthCodeDrafts[providerId]?.trim();
      if (!draft) {
        toast.error('Paste the Claude code#state value first');
        return;
      }

      const actionKey = `${providerId}:oauth`;
      setAuthStateMessage(actionKey, 'Working...');

      try {
        await submitAgentProviderOAuthCode(slug, agentId, providerId, draft);
        setOauthCodeDrafts((current) => ({ ...current, [providerId]: '' }));
        setAuthStateMessage(actionKey, 'Connected');
        await refreshProviderAuthState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to complete Claude login';
        setAuthStateMessage(actionKey, message);
        toast.error(message);
      }
    },
    [agentId, oauthCodeDrafts, refreshProviderAuthState, setAuthStateMessage, slug]
  );

  const handleStartDeviceCode = useCallback(
    async (providerId: string) => {
      const actionKey = `${providerId}:device`;
      setAuthStateMessage(actionKey, 'Starting...');

      try {
        const started = await startAgentProviderDeviceCode(providerId, agentId);
        setDeviceCodeStates((current) => ({
          ...current,
          [providerId]: {
            ...started,
            status: 'pending',
          },
        }));
        setAuthStateMessage(actionKey, '');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to start device code flow';
        setAuthStateMessage(actionKey, message);
        toast.error(message);
      }
    },
    [agentId, setAuthStateMessage]
  );

  const handlePollDeviceCode = useCallback(
    async (providerId: string) => {
      const currentState = deviceCodeStates[providerId];
      if (!currentState) return;

      const actionKey = `${providerId}:device`;
      setAuthStateMessage(actionKey, 'Checking...');

      try {
        const result = await pollAgentProviderDeviceCode(providerId, {
          agentId,
          deviceAuthId: currentState.deviceAuthId,
          userCode: currentState.userCode,
        });

        if (result.status === 'success') {
          setDeviceCodeStates((current) => ({
            ...current,
            [providerId]: {
              ...currentState,
              status: 'success',
              message: result.accountId ? `Connected account ${result.accountId}` : 'Connected',
            },
          }));
          setAuthStateMessage(actionKey, '');
          await refreshProviderAuthState();
          return;
        }

        setDeviceCodeStates((current) => ({
          ...current,
          [providerId]: {
            ...currentState,
            status: 'pending',
            message: result.error || 'Still waiting for approval',
          },
        }));
        setAuthStateMessage(actionKey, result.error || '');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to check device code status';
        setDeviceCodeStates((current) => ({
          ...current,
          [providerId]: currentState
            ? {
                ...currentState,
                status: 'error',
                message,
              }
            : currentState,
        }));
        setAuthStateMessage(actionKey, message);
        toast.error(message);
      }
    },
    [agentId, deviceCodeStates, refreshProviderAuthState, setAuthStateMessage]
  );

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading agent settings...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
        <p className="text-muted-foreground">
          {providerRows.length === 0
            ? 'No providers configured yet.'
            : `${providerRows.length} provider${providerRows.length === 1 ? '' : 's'} configured.`}
        </p>
        {showProviderPicker ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowProviderPicker(false)}
            disabled={isPending}
          >
            <X className="h-4 w-4" />
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setShowProviderPicker(true)}
            disabled={!availableProviders.length || isPending}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-muted/20 p-4 text-sm">
        <p className="font-medium">Provider order controls auto selection.</p>
        <p className="mt-1 text-muted-foreground">
          The first provider is treated as primary. Set a provider model to pin that provider&apos;s
          default model, or leave it on auto to let Lobu resolve its default.
        </p>
      </div>

      {showProviderPicker ? (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Choose a provider</p>
            <p className="text-sm text-muted-foreground">
              Pick the model provider this agent should use. You can change auth method and model
              preference after adding it.
            </p>
          </div>

          <div className="space-y-2">
            {availableProviders.map((provider) => (
              <button
                key={provider.providerId}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50"
                onClick={() => addProvider(provider.providerId)}
                disabled={isPending}
              >
                {provider.iconUrl ? (
                  <img src={provider.iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
                ) : (
                  <div className="h-4 w-4 shrink-0 rounded-sm bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{provider.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {provider.description ||
                      'Add this provider to configure auth and model selection.'}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {providerRows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Add at least one provider to choose how this agent authenticates and which model each
          provider should prefer.
        </div>
      ) : null}

      {providerRows.map((row, index) => {
        const provider = catalog.find((entry) => entry.providerId === row.providerId);
        const modelOptions = models[row.providerId] ?? [];
        const instructionText = getProviderInstructions(provider, row.authType);
        const authTabValues = provider?.supportedAuthTypes ?? [row.authType];
        const oauthDraft = oauthCodeDrafts[row.providerId] ?? '';
        const deviceCodeState = deviceCodeStates[row.providerId];
        const authStatusCopy = getConnectedCopy(row.existingProfile, row.authType);
        const authActionMessage =
          authActionState[
            `${row.providerId}:${row.authType === 'device-code' ? 'device' : 'oauth'}`
          ] ?? '';
        const canPickModel = canConfigureProviderModel(row, provider);
        const oauthLoginUrl =
          slug && row.providerId === 'claude'
            ? getAgentProviderOAuthStartUrl(slug, row.providerId, agentId)
            : null;

        return (
          <div key={row.providerId} className="space-y-4 rounded-lg border bg-background p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{provider?.name ?? row.providerId}</p>
                  {index === 0 ? <Badge variant="secondary">Primary</Badge> : null}
                  {provider?.systemAvailable ? <Badge variant="outline">System key</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {provider?.description || row.providerId}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => moveProvider(row.providerId, -1)}
                  disabled={index === 0 || isPending}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => moveProvider(row.providerId, 1)}
                  disabled={index === providerRows.length - 1 || isPending}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeProvider(row.providerId)}
                  disabled={isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-3 md:col-span-2">
                <Tabs
                  value={row.authType}
                  onValueChange={(value) =>
                    updateProviderRow(row.providerId, {
                      authType: value as AgentAuthType,
                      credential: '',
                    })
                  }
                >
                  <TabsList>
                    {authTabValues.map((authType) => (
                      <TabsTrigger key={authType} value={authType} disabled={isPending}>
                        {getAuthTabLabel(provider, authType)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                {authStatusCopy ? (
                  <p className="text-xs text-muted-foreground">{authStatusCopy}</p>
                ) : null}

                {row.authType === 'oauth' && row.providerId === 'claude' ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      {oauthLoginUrl ? (
                        <Button type="button" variant="outline" asChild>
                          <a href={oauthLoginUrl} target="_blank" rel="noreferrer">
                            Login with Claude
                            <ArrowUpRight className="h-4 w-4" />
                          </a>
                        </Button>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Finish the Claude approval flow, then paste the returned
                        <span className="px-1 font-mono">code#state</span>.
                      </p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                      <div className="grid gap-2">
                        <Label>Claude Code</Label>
                        <Input
                          value={oauthDraft}
                          onChange={(event) => setAuthDraft(row.providerId, event.target.value)}
                          placeholder={getCredentialPlaceholder(provider, row.authType)}
                          disabled={isPending}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleClaudeOAuthSubmit(row.providerId)}
                        disabled={!oauthDraft.trim() || isPending}
                      >
                        Complete Login
                      </Button>
                    </div>
                    {authActionMessage ? (
                      <p className="text-xs text-muted-foreground">{authActionMessage}</p>
                    ) : null}
                  </div>
                ) : null}

                {row.authType === 'device-code' && row.providerId === 'chatgpt' ? (
                  <div className="grid gap-3 rounded-md border p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleStartDeviceCode(row.providerId)}
                        disabled={isPending}
                      >
                        {deviceCodeState ? 'Get New Code' : 'Get Device Code'}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Use the generated code at ChatGPT, then refresh status here.
                      </p>
                    </div>
                    {deviceCodeState ? (
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="grid gap-2">
                          <Label>Device Code</Label>
                          <Input readOnly value={deviceCodeState.userCode} />
                          <p className="text-xs text-muted-foreground">
                            {deviceCodeState.message || 'Waiting for ChatGPT approval.'}
                          </p>
                        </div>
                        <div className="flex flex-col gap-2 self-end">
                          <Button type="button" variant="outline" asChild>
                            <a
                              href={deviceCodeState.verificationUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open ChatGPT
                              <ArrowUpRight className="h-4 w-4" />
                            </a>
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => handlePollDeviceCode(row.providerId)}
                            disabled={isPending || deviceCodeState.status === 'success'}
                          >
                            {deviceCodeState.status === 'success' ? 'Connected' : 'Refresh Status'}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {authActionMessage ? (
                      <p className="text-xs text-muted-foreground">{authActionMessage}</p>
                    ) : null}
                  </div>
                ) : null}

                {row.authType === 'api-key' ? (
                  <div className="grid gap-2">
                    <Label>API Key</Label>
                    <Input
                      type="password"
                      value={row.credential}
                      onChange={(event) =>
                        updateProviderRow(row.providerId, {
                          credential: event.target.value,
                        })
                      }
                      placeholder={getCredentialPlaceholder(provider, row.authType)}
                      disabled={isPending}
                      autoComplete="off"
                    />
                    {instructionText ? (
                      <p className="text-xs text-muted-foreground">{instructionText}</p>
                    ) : null}
                  </div>
                ) : null}

                {row.authType === 'oauth' && row.providerId !== 'claude' ? (
                  <div className="grid gap-2">
                    <Label>OAuth Credential</Label>
                    <Input
                      type="password"
                      value={row.credential}
                      onChange={(event) =>
                        updateProviderRow(row.providerId, {
                          credential: event.target.value,
                        })
                      }
                      placeholder={getCredentialPlaceholder(provider, row.authType)}
                      disabled={isPending}
                      autoComplete="off"
                    />
                  </div>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label>Model</Label>
                {canPickModel ? (
                  modelOptions.length > 0 ? (
                    <Select
                      value={row.modelPreference || AUTO_MODEL_VALUE}
                      onValueChange={(value) =>
                        updateProviderRow(row.providerId, {
                          modelPreference: value === AUTO_MODEL_VALUE ? '' : value,
                        })
                      }
                      disabled={isPending}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AUTO_MODEL_VALUE}>Auto</SelectItem>
                        {modelOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <>
                      <Input
                        value={row.modelPreference}
                        onChange={(event) =>
                          updateProviderRow(row.providerId, {
                            modelPreference: event.target.value,
                          })
                        }
                        placeholder="Leave blank for auto"
                        disabled={isPending}
                      />
                      <p className="text-xs text-muted-foreground">
                        Empty means auto. Enter a full model ref if this provider does not expose a
                        model list here.
                      </p>
                    </>
                  )
                ) : (
                  <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    Connect this provider first to choose a model or use auto resolution.
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
