import { useNavigate } from '@tanstack/react-router';
import { Bot, Search, Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentEditorSheet,
  type AgentSheetMode,
  ClientDetailSheet,
} from '@/components/agents/agent-sheets';
import { AgentsSidebarCard } from '@/components/agents/agents-sidebar-card';
import { mcpSoftwareLabel, platformLabel, statusTone } from '@/components/agents/ui-utils';
import { WorkspaceBreadcrumbSelector } from '@/components/breadcrumbs/breadcrumb-selector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCurrentOrg } from '@/hooks/use-current-org';
import { useFeatures } from '@/hooks/use-features';
import { useOrgContext } from '@/hooks/use-org-context';
import {
  type ConnectedClientItem,
  useAgents,
  useConnectedClients,
  useResolvedPath,
} from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import { formatTimeAgo } from '@/lib/format-utils';

const McpConnect = lazy(async () => ({
  default: (await import('@/components/mcp-connect')).McpConnect,
}));

function getClientPrimaryLabel(client: ConnectedClientItem): string {
  if (client.kind === 'messaging') {
    const identifier = client.identifier?.trim();
    if (identifier && client.platform === 'telegram') {
      const normalized = identifier.replace(/^@/, '').trim();
      if (/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(normalized)) {
        return `@${normalized}`;
      }
    }
    return identifier || client.title || 'Unknown';
  }

  return client.title || client.identifier || 'Unknown';
}

function getClientMemberLabel(client: ConnectedClientItem): string | null {
  if (client.linkedUserName || client.linkedUserEmail) {
    return [client.linkedUserName, client.linkedUserEmail].filter(Boolean).join(' · ');
  }
  return null;
}

function getClientApplicationLabel(client: ConnectedClientItem): string {
  if (client.kind === 'mcp') {
    return mcpSoftwareLabel(client.platform, client.title) || client.title || 'MCP Client';
  }
  return client.platform ? platformLabel(client.platform) : 'Messaging';
}

export function AgentsPageView({
  owner,
  openedAgentId = null,
  createMode = false,
}: {
  owner: string;
  openedAgentId?: string | null;
  createMode?: boolean;
}) {
  const navigate = useNavigate();
  const { orgContext, hasOrgContext } = useOrgContext();
  const { data: resolvedData, isLoading: isResolvedLoading } = useResolvedPath(
    `/${owner}`,
    orgContext
  );
  const { isAuthenticated } = useAuthState();
  const { isMember, isLoading: isOrgLoading } = useCurrentOrg();
  // Non-members of a public workspace get the same read-only view as anonymous
  // visitors — no agent list, no connected clients, just the "Connect Your
  // Agent" card. Backend endpoints gate writes, but keeping the UI symmetric
  // avoids exposing connection metadata to casual visitors.
  const canManageWorkspace = isAuthenticated && isMember;
  const { data: agents = [], isLoading: isAgentsLoading } = useAgents({
    enabled: canManageWorkspace,
  });
  const features = useFeatures();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<ConnectedClientItem | null>(null);
  const pageSize = 25;

  const workspace = resolvedData?.workspace;
  const workspaceName = workspace?.name || owner;
  const canManageEmbeddedAgents = features.lobuEmbedded && canManageWorkspace;
  const isLoading = canManageWorkspace
    ? !hasOrgContext || isResolvedLoading || isAgentsLoading || isOrgLoading
    : isResolvedLoading || isOrgLoading;
  const { data: clients = [], isLoading: isClientsLoading } = useConnectedClients(
    selectedAgentId,
    { enabled: canManageWorkspace }
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );
  const openedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === openedAgentId) ?? null,
    [agents, openedAgentId]
  );
  const sheetMode = useMemo<AgentSheetMode | null>(() => {
    if (createMode) return { kind: 'create' };
    if (openedAgent) return { kind: 'edit', agent: openedAgent };
    return null;
  }, [createMode, openedAgent]);

  useEffect(() => {
    if (selectedAgentId && !agents.some((agent) => agent.agentId === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (createMode || !openedAgentId || isAgentsLoading) return;
    if (openedAgent) return;
    void navigate({ to: `/${owner}/agents` as '/', replace: true });
  }, [createMode, isAgentsLoading, navigate, openedAgent, openedAgentId, owner]);

  const filteredClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return clients;

    return clients.filter((client) =>
      [
        client.title,
        client.identifier,
        client.platform,
        client.assignedAgentName,
        client.assignedAgentId,
        client.userAgent,
        client.linkedUserName,
        client.linkedUserEmail,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    );
  }, [clients, search]);

  const totalCount = filteredClients.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageRows = filteredClients.slice(page * pageSize, page * pageSize + pageSize);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(0);
  }, []);

  const handleSelectAgent = useCallback((agentId: string | null) => {
    setSelectedAgentId(agentId);
    setPage(0);
  }, []);

  const handleOpenCreateSheet = useCallback(() => {
    void navigate({
      to: `/${owner}/agents` as '/',
      search: { create: true },
    });
  }, [navigate, owner]);

  const handleOpenEditSheet = useCallback(
    (agentId: string) => {
      void navigate({ to: `/${owner}/agents/${agentId}` as '/' });
    },
    [navigate, owner]
  );

  const handleSheetOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) return;
      void navigate({ to: `/${owner}/agents` as '/', replace: true });
    },
    [navigate, owner]
  );

  const handleAgentCreated = useCallback(
    async (agentId: string) => {
      await navigate({ to: `/${owner}/agents/${agentId}` as '/' });
    },
    [navigate, owner]
  );

  useEffect(() => {
    if (page > 0 && page >= totalPages) {
      setPage(totalPages - 1);
    }
  }, [page, totalPages]);

  if (!isLoading && workspace && workspace.type !== 'organization') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="max-w-md text-muted-foreground">
          Select an organization from the sidebar to view agents.
        </p>
      </div>
    );
  }

  if (!canManageWorkspace) {
    const subtitle = isAuthenticated
      ? `Connect your MCP-capable client to ${workspaceName}. Join the workspace to manage always-on agents and view connected clients.`
      : `Connect your MCP-capable client to ${workspaceName}. Sign in to manage always-on agents and view connected clients.`;
    return (
      <div className="flex flex-1 flex-col gap-6 py-4 px-4 lg:px-6">
        <div className="space-y-2">
          <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <WorkspaceBreadcrumbSelector currentSlug={owner} currentName={workspaceName} />
            <span>/</span>
            <span className="text-foreground">Agents</span>
          </nav>

          <div className="flex items-center gap-2">
            <Bot className="h-7 w-7" />
            <h1 className="text-3xl font-semibold leading-tight">Agents</h1>
          </div>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>

        <div className="max-w-2xl">
          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Sparkles className="h-5 w-5" />
                Connect Your Agent
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    Loading...
                  </div>
                }
              >
                <McpConnect orgSlug={workspace?.slug} />
              </Suspense>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6 py-4 px-4 lg:px-6">
      <div className="space-y-2">
        <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <WorkspaceBreadcrumbSelector currentSlug={owner} currentName={workspaceName} />
          <span>/</span>
          <span className="text-foreground">Agents</span>
        </nav>

        <div className="flex items-center gap-2">
          <Bot className="h-7 w-7" />
          <h1 className="text-3xl font-semibold leading-tight">Agents</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Inspect connected clients on the left and configure always-on agents from the sidebar.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_460px]">
        <div className="space-y-4">
          {!features.lobuEmbedded ? (
            <div className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
              Embedded Lobu runtime is not available in this environment. Messaging clients and
              always-on agent runtime controls are unavailable, but MCP clients are still shown
              below.
            </div>
          ) : null}

          {selectedAgent ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Filtered by {selectedAgent.name}</Badge>
              <Button variant="outline" size="sm" onClick={() => handleSelectAgent(null)}>
                Clear Filter
              </Button>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search clients..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {isClientsLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              Loading connected clients...
            </div>
          ) : totalCount > 0 ? (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Application</TableHead>
                      <TableHead>Member</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Auth</TableHead>
                      <TableHead>Last Seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((client) => (
                      <TableRow
                        key={`${client.kind}:${client.id}`}
                        className="cursor-pointer"
                        onClick={() => setSelectedClient(client)}
                      >
                        <TableCell>
                          <div className="font-medium">{getClientPrimaryLabel(client)}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{getClientApplicationLabel(client)}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {getClientMemberLabel(client) || '—'}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {client.assignedAgentName || 'Unassigned'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={statusTone(client.authState)}>
                            {client.authState}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {client.lastSeenAt ? formatTimeAgo(client.lastSeenAt) : 'Never'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <div>
                  Showing {pageRows.length} of {totalCount} clients
                </div>
                <div className="flex items-center gap-2">
                  <span>
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                    disabled={page === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
                    disabled={page + 1 >= totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {selectedAgent
                ? `No clients matched ${selectedAgent.name}.`
                : 'No connected clients yet. Connect an MCP client or add a platform connection to an agent.'}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <AgentsSidebarCard
            agents={agents}
            selectedAgentId={selectedAgentId}
            allClientsCount={clients.length}
            showAllClientsOption
            onCreateAgent={handleOpenCreateSheet}
            canCreateAgent={canManageEmbeddedAgents}
            onSelectAgent={handleSelectAgent}
            onOpenAgent={handleOpenEditSheet}
            footer={
              !canManageEmbeddedAgents ? (
                <p className="border-t pt-4 text-xs text-muted-foreground">
                  Sign in and enable the embedded runtime to manage always-on agents.
                </p>
              ) : null
            }
          />

          <Card className="border-border/80 shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <Sparkles className="h-5 w-5" />
                Connect Your Agent
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    Loading...
                  </div>
                }
              >
                <McpConnect orgSlug={workspace?.slug} />
              </Suspense>
            </CardContent>
          </Card>
        </div>
      </div>

      <AgentEditorSheet
        mode={sheetMode}
        open={sheetMode !== null}
        existingAgentIds={agents.map((agent) => agent.agentId)}
        onCreated={handleAgentCreated}
        onOpenChange={handleSheetOpenChange}
      />

      <ClientDetailSheet
        client={selectedClient}
        open={selectedClient !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedClient(null);
        }}
      />
    </div>
  );
}
