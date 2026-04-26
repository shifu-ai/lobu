import { ArrowUpRight, Plus, Unplug, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AgentConnections } from '@/components/agents/agent-connections';
import { buildGeneratedAgentId } from '@/components/agents/agent-id-utils';
import { CollapsibleFormSection } from '@/components/agents/collapsible-form-section';
import { safePrettyJson } from '@/components/agents/json-field';
import {
  buildProviderLabel,
  buildProviderRows,
  canConfigureProviderModel,
  getProviderName,
  type ProviderEditorRow,
  ProviderEditorSection,
} from '@/components/agents/provider-editor';
import {
  buildSkillRows,
  type SkillEditorRow,
  SkillEditorSection,
  skillRowsToSkillsConfig,
} from '@/components/agents/skill-editor';
import { formatDateTime, platformLabel, statusTone } from '@/components/agents/ui-utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  type AgentItem,
  type ConnectedClientItem,
  useAgentConfig,
  useAgentProviderCatalog,
  useAgentSkillsCatalog,
  useCreateAgent,
  useDeleteAgent,
  useDisconnectMcpClient,
  useUpdateAgent,
  useUpdateAgentConfig,
} from '@/lib/api';
import { useAgentConnections } from '@/lib/api/agents';
import { getPathScope } from '@/lib/api/core';

export type AgentSheetMode =
  | { kind: 'create' }
  | {
      kind: 'edit';
      agent: AgentItem;
    };

type EditorSectionKey = 'identity' | 'providers' | 'skills' | 'connections';

const DEFAULT_EDITOR_SECTION_STATE: Record<EditorSectionKey, boolean> = {
  identity: false,
  providers: false,
  skills: false,
  connections: false,
};

export function ClientDetailSheet({
  client,
  open,
  onOpenChange,
}: {
  client: ConnectedClientItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const disconnectMcpClient = useDisconnectMcpClient();
  const clientTitle = client?.title || client?.identifier || 'Connected client';
  const clientPlatformLabel = client?.platform ? platformLabel(client.platform) : null;
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  useEffect(() => {
    setConfirmingDisconnect(false);
  }, [client?.id, open]);

  const handleDisconnect = useCallback(async () => {
    if (!client || client.kind !== 'mcp') return;
    await disconnectMcpClient.mutateAsync(client.id);
    setConfirmingDisconnect(false);
    onOpenChange(false);
  }, [client, disconnectMcpClient, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[560px]">
        {client ? (
          <>
            <SheetHeader>
              <SheetTitle>{clientTitle}</SheetTitle>
              <SheetDescription>
                {client.kind === 'mcp'
                  ? 'MCP client activity and authorization details for this workspace.'
                  : 'Messaging identity linked through an always-on agent.'}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 py-6">
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Type</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{client.kind === 'mcp' ? 'MCP' : 'Messaging'}</Badge>
                    {clientPlatformLabel ? (
                      <Badge variant="outline">{clientPlatformLabel}</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Auth</span>
                  <Badge variant="outline" className={statusTone(client.authState)}>
                    {client.authState}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Assigned agent</span>
                  <span>{client.assignedAgentName || 'Unassigned'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Identifier</span>
                  <span className="truncate">{client.identifier || 'Not provided'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Last seen</span>
                  <span>{formatDateTime(client.lastSeenAt)}</span>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label>User Agent</Label>
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    {client.userAgent || 'Not reported'}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Linked User</Label>
                  <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    {client.linkedUserName || client.linkedUserEmail
                      ? [client.linkedUserName, client.linkedUserEmail].filter(Boolean).join(' · ')
                      : 'No linked Lobu user'}
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Capabilities</Label>
                  <Textarea
                    readOnly
                    value={safePrettyJson(client.capabilities, {})}
                    rows={8}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Details</Label>
                  <Textarea
                    readOnly
                    value={safePrettyJson(client.details, {})}
                    rows={8}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              {client.kind === 'mcp' ? (
                confirmingDisconnect ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={disconnectMcpClient.isPending}
                      onClick={() => void handleDisconnect()}
                    >
                      {disconnectMcpClient.isPending ? 'Revoking...' : 'Revoke Client'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disconnectMcpClient.isPending}
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={disconnectMcpClient.isPending}
                    onClick={() => setConfirmingDisconnect(true)}
                  >
                    <Unplug className="h-4 w-4" />
                    Revoke Client
                  </Button>
                )
              ) : (
                <span />
              )}

              <div className="flex gap-2">
                {client.externalUrl ? (
                  <Button type="button" variant="outline" asChild>
                    <a href={client.externalUrl} target="_blank" rel="noreferrer">
                      Open in Platform
                      <ArrowUpRight className="ml-2 h-4 w-4" />
                    </a>
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function AgentEditorSheet({
  mode,
  open,
  onOpenChange,
  existingAgentIds = [],
  onCreated,
}: {
  mode: AgentSheetMode | null;
  open: boolean;
  existingAgentIds?: string[];
  onCreated?: (agentId: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const isCreate = mode?.kind === 'create';
  const selectedAgent = mode?.kind === 'edit' ? mode.agent : null;
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent(selectedAgent?.agentId ?? '');
  const deleteAgent = useDeleteAgent(selectedAgent?.agentId ?? '');
  const updateAgentConfig = useUpdateAgentConfig(selectedAgent?.agentId ?? '');
  const { slug } = getPathScope();
  const { data: agentConfig, isLoading: isConfigLoading } = useAgentConfig(selectedAgent?.agentId);
  const { data: providerCatalog, isLoading: isProviderCatalogLoading } = useAgentProviderCatalog(
    selectedAgent?.agentId
  );
  const { data: skillsCatalog, isLoading: isSkillsCatalogLoading } = useAgentSkillsCatalog(
    selectedAgent?.agentId
  );
  const { data: agentConnections = [] } = useAgentConnections(selectedAgent?.agentId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [identityMd, setIdentityMd] = useState('');
  const [soulMd, setSoulMd] = useState('');
  const [userMd, setUserMd] = useState('');
  const [providerRows, setProviderRows] = useState<ProviderEditorRow[]>([]);
  const [skillRows, setSkillRows] = useState<SkillEditorRow[]>([]);
  const [connectionsAddMode, setConnectionsAddMode] = useState(false);
  const [sheetReadyForClose, setSheetReadyForClose] = useState(false);
  const [confirmingDeleteAgent, setConfirmingDeleteAgent] = useState(false);
  const [openSections, setOpenSections] = useState<Record<EditorSectionKey, boolean>>({
    ...DEFAULT_EDITOR_SECTION_STATE,
  });

  useEffect(() => {
    if (!open || !mode) return;

    if (mode.kind === 'create') {
      setName('');
      setDescription('');
      setIdentityMd('');
      setSoulMd('');
      setUserMd('');
      setProviderRows([]);
      setSkillRows([]);
      setConnectionsAddMode(false);
      return;
    }

    setName(mode.agent.name);
    setDescription(mode.agent.description ?? '');
    setConnectionsAddMode(false);
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    setOpenSections({ ...DEFAULT_EDITOR_SECTION_STATE });
  }, [open]);

  useEffect(() => {
    setConfirmingDeleteAgent(false);
  }, [open, selectedAgent?.agentId]);

  useEffect(() => {
    if (!open) {
      setSheetReadyForClose(false);
      return;
    }

    setSheetReadyForClose(false);
    const frameId = window.requestAnimationFrame(() => {
      setSheetReadyForClose(true);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [open]);

  useEffect(() => {
    if (!open || !selectedAgent || !agentConfig) return;
    setIdentityMd(agentConfig.identityMd ?? '');
    setSoulMd(agentConfig.soulMd ?? '');
    setUserMd(agentConfig.userMd ?? '');
  }, [agentConfig, open, selectedAgent]);

  useEffect(() => {
    if (!open || !selectedAgent || !agentConfig || !providerCatalog) return;
    setProviderRows(buildProviderRows(agentConfig, providerCatalog.catalog));
  }, [agentConfig, open, providerCatalog, selectedAgent]);

  useEffect(() => {
    if (!open || !selectedAgent || !agentConfig || !skillsCatalog) return;
    setSkillRows(buildSkillRows(agentConfig, skillsCatalog.catalog));
  }, [agentConfig, open, selectedAgent, skillsCatalog]);

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleSheetOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !sheetReadyForClose) return;
      onOpenChange(nextOpen);
    },
    [onOpenChange, sheetReadyForClose]
  );

  const handleSectionOpenChange = useCallback((section: EditorSectionKey, nextOpen: boolean) => {
    setOpenSections((current) => ({ ...current, [section]: nextOpen }));
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      if (isCreate) {
        const created = await createAgent.mutateAsync({
          agentId: buildGeneratedAgentId(name, existingAgentIds),
          name: name.trim(),
          description: description.trim() || undefined,
        });
        if (onCreated) {
          await onCreated(created.agentId);
        } else {
          onOpenChange(false);
        }
        return;
      }

      if (!selectedAgent) return;

      try {
        const installedProviderMap = new Map(
          (agentConfig?.installedProviders ?? []).map((provider) => [provider.providerId, provider])
        );
        const providerCatalogMap = new Map(
          (providerCatalog?.catalog ?? []).map((provider) => [provider.providerId, provider])
        );
        const installedProviders = providerRows.map((row) => {
          const existing = installedProviderMap.get(row.providerId);
          return {
            providerId: row.providerId,
            installedAt: existing?.installedAt ?? Date.now(),
            ...(existing?.config ? { config: existing.config } : {}),
          };
        });

        const providerModelPreferences = Object.fromEntries(
          providerRows
            .map((row) => [row.providerId, row.modelPreference.trim()] as const)
            .filter(([providerId, modelPreference]) => {
              if (modelPreference.length === 0) return false;
              const provider = providerCatalogMap.get(providerId);
              const row = providerRows.find((entry) => entry.providerId === providerId);
              return row ? canConfigureProviderModel(row, provider) : false;
            })
        );

        const authProfiles = providerRows
          .map((row) => {
            const credential = row.credential.trim();
            const existingProfile = row.existingProfile;
            if (!credential) {
              return existingProfile?.authType === row.authType ? existingProfile : null;
            }

            const providerName = getProviderName(row.providerId, providerCatalog?.catalog ?? []);

            return {
              id: existingProfile?.id ?? crypto.randomUUID(),
              provider: row.providerId,
              model: existingProfile?.model ?? '*',
              credential,
              label: buildProviderLabel(
                providerName,
                row.authType,
                credential,
                existingProfile?.label
              ),
              authType: row.authType,
              ...(existingProfile?.metadata ? { metadata: existingProfile.metadata } : {}),
              createdAt: existingProfile?.createdAt ?? Date.now(),
            };
          })
          .filter((profile): profile is NonNullable<typeof profile> => profile !== null);

        await Promise.all([
          updateAgent.mutateAsync({
            name: name.trim() || selectedAgent.name,
            description: description.trim() || undefined,
          }),
          updateAgentConfig.mutateAsync({
            identityMd: identityMd.trim(),
            soulMd: soulMd.trim(),
            userMd: userMd.trim(),
            model: undefined,
            modelSelection: { mode: 'auto' },
            providerModelPreferences:
              Object.keys(providerModelPreferences).length > 0
                ? providerModelPreferences
                : undefined,
            authProfiles,
            installedProviders,
            skillsConfig: skillRowsToSkillsConfig(skillRows),
          }),
        ]);
        onOpenChange(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to save agent');
      }
    },
    [
      agentConfig?.installedProviders,
      createAgent,
      description,
      existingAgentIds,
      identityMd,
      isCreate,
      name,
      onCreated,
      onOpenChange,
      providerCatalog?.catalog,
      providerRows,
      selectedAgent,
      skillRows,
      soulMd,
      updateAgent,
      updateAgentConfig,
      userMd,
    ]
  );

  const handleDelete = useCallback(async () => {
    if (!selectedAgent) return;
    await deleteAgent.mutateAsync();
    setConfirmingDeleteAgent(false);
    onOpenChange(false);
  }, [deleteAgent, onOpenChange, selectedAgent]);

  const isPending =
    createAgent.isPending ||
    updateAgent.isPending ||
    deleteAgent.isPending ||
    updateAgentConfig.isPending;
  const isProviderSettingsLoading = isConfigLoading || isProviderCatalogLoading;
  const canSubmit = name.trim().length > 0;

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[720px]">
        {mode ? (
          <form onSubmit={handleSubmit} className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle>
                {isCreate ? 'Create Agent' : (selectedAgent?.name ?? 'Agent')}
              </SheetTitle>
              <SheetDescription>
                {isCreate
                  ? 'Create a durable agent identity for always-on automation and client attribution.'
                  : 'Configure the agent, its providers, and its messaging connections.'}
              </SheetDescription>
            </SheetHeader>

            <div className="grid flex-1 content-start gap-4 py-6">
              <div className="grid gap-2">
                <Label htmlFor="agent-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="agent-name"
                  placeholder="Support Bot"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isPending}
                  required
                />
                {isCreate ? (
                  <p className="text-[11px] text-muted-foreground">
                    The agent ID will be generated automatically from the name.
                  </p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="agent-description">Description</Label>
                <Textarea
                  id="agent-description"
                  placeholder="Handles customer support and triage across channels."
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={isPending}
                  rows={3}
                />
              </div>

              {selectedAgent ? (
                <div className="space-y-6">
                  <CollapsibleFormSection
                    title="Identity"
                    description="Core prompt fields for the agent's role, voice, and operating rules."
                    open={openSections.identity}
                    onOpenChange={(nextOpen) => handleSectionOpenChange('identity', nextOpen)}
                  >
                    {isConfigLoading ? (
                      <p className="text-sm text-muted-foreground">Loading agent settings...</p>
                    ) : (
                      <>
                        <div className="grid gap-2">
                          <Label htmlFor="identity-md">Identity</Label>
                          <Textarea
                            id="identity-md"
                            rows={6}
                            value={identityMd}
                            onChange={(event) => setIdentityMd(event.target.value)}
                            placeholder="You are a market intelligence agent. Track competitors, analyze launches and signals, and surface concise, decision-ready insights."
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="soul-md">Soul</Label>
                          <Textarea
                            id="soul-md"
                            rows={6}
                            value={soulMd}
                            onChange={(event) => setSoulMd(event.target.value)}
                            placeholder="Be rigorous, skeptical of weak signals, and calm under ambiguity. Prefer crisp summaries, explicit evidence, and clear confidence levels."
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="user-md">User Prompt</Label>
                          <Textarea
                            id="user-md"
                            rows={6}
                            value={userMd}
                            onChange={(event) => setUserMd(event.target.value)}
                            placeholder="Monitor the market for notable competitor moves, pricing changes, launches, partnerships, and customer sentiment shifts. Summarize what changed, why it matters, and what to watch next."
                          />
                        </div>
                      </>
                    )}
                  </CollapsibleFormSection>

                  <CollapsibleFormSection
                    title="Providers"
                    description="Authentication, provider order, and model selection for the runtime."
                    open={openSections.providers}
                    onOpenChange={(nextOpen) => handleSectionOpenChange('providers', nextOpen)}
                    titleMeta={<Badge variant="secondary">{providerRows.length}</Badge>}
                  >
                    <ProviderEditorSection
                      agentId={selectedAgent.agentId}
                      slug={slug || ''}
                      providerRows={providerRows}
                      setProviderRows={setProviderRows}
                      catalog={providerCatalog?.catalog ?? []}
                      models={providerCatalog?.models ?? {}}
                      isLoading={isProviderSettingsLoading}
                      isPending={isPending}
                    />
                  </CollapsibleFormSection>

                  <CollapsibleFormSection
                    title="Skills"
                    description="Capability access for MCP, network, and package requirements."
                    open={openSections.skills}
                    onOpenChange={(nextOpen) => handleSectionOpenChange('skills', nextOpen)}
                    titleMeta={<Badge variant="secondary">{skillRows.length}</Badge>}
                  >
                    <SkillEditorSection
                      skillRows={skillRows}
                      setSkillRows={setSkillRows}
                      catalog={skillsCatalog?.catalog ?? []}
                      isLoading={isConfigLoading || isSkillsCatalogLoading}
                      isPending={isPending}
                    />
                  </CollapsibleFormSection>

                  <CollapsibleFormSection
                    title="Connections"
                    description="Messaging and delivery channels bound to this agent."
                    open={openSections.connections}
                    onOpenChange={(nextOpen) => handleSectionOpenChange('connections', nextOpen)}
                    titleMeta={<Badge variant="secondary">{agentConnections.length}</Badge>}
                  >
                    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
                      <p className="text-muted-foreground">
                        {agentConnections.length === 0
                          ? 'No connections configured yet.'
                          : `${agentConnections.length} connection${agentConnections.length === 1 ? '' : 's'} configured.`}
                      </p>
                      {connectionsAddMode ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConnectionsAddMode(false)}
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
                          onClick={() => setConnectionsAddMode(true)}
                          disabled={isPending}
                        >
                          <Plus className="h-4 w-4" />
                          Add
                        </Button>
                      )}
                    </div>
                    <AgentConnections
                      agentId={selectedAgent.agentId}
                      showToolbar={false}
                      addMode={connectionsAddMode}
                      onAddModeChange={setConnectionsAddMode}
                    />
                  </CollapsibleFormSection>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              {selectedAgent ? (
                confirmingDeleteAgent ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => void handleDelete()}
                      disabled={deleteAgent.isPending}
                    >
                      {deleteAgent.isPending ? 'Deleting...' : 'Delete Agent'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setConfirmingDeleteAgent(false)}
                      disabled={deleteAgent.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmingDeleteAgent(true)}
                    disabled={deleteAgent.isPending}
                  >
                    Delete Agent
                  </Button>
                )
              ) : (
                <span />
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={handleClose} disabled={isPending}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSubmit || isPending}>
                  {isCreate
                    ? createAgent.isPending
                      ? 'Creating...'
                      : 'Create Agent'
                    : updateAgent.isPending || updateAgentConfig.isPending
                      ? 'Saving...'
                      : 'Save Changes'}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
