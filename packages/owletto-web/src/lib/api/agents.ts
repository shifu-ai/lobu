import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL, fetchWithTimeout, getPathScope } from './core';

// ============================================================
// Types
// ============================================================

export interface AgentItem {
  agentId: string;
  name: string;
  description?: string;
  owner: { platform: string; userId: string };
  isWorkspaceAgent?: boolean;
  createdAt: number;
  lastUsedAt?: number;
  connectionCount: number;
  activeConnectionCount: number;
  clientCount: number;
  status: 'active' | 'idle';
}

export type AgentAuthType = 'oauth' | 'device-code' | 'api-key';

export interface AgentAuthProfile {
  id: string;
  provider: string;
  model: string;
  credential: string;
  label: string;
  authType: AgentAuthType;
  metadata?: {
    email?: string;
    expiresAt?: number;
    refreshToken?: string;
    accountId?: string;
  };
  createdAt: number;
}

export interface AgentInstalledProvider {
  providerId: string;
  installedAt: number;
  config?: {
    baseUrl?: string;
    [key: string]: unknown;
  };
}

export interface AgentProviderModelOption {
  label: string;
  value: string;
  description?: string;
}

export interface AgentProviderCatalogItem {
  providerId: string;
  name: string;
  iconUrl: string;
  authType: AgentAuthType;
  supportedAuthTypes: AgentAuthType[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  description: string;
  systemAvailable: boolean;
  installed: boolean;
}

export interface AgentProviderCatalogResponse {
  catalog: AgentProviderCatalogItem[];
  installedProviders: AgentInstalledProvider[];
  models: Record<string, AgentProviderModelOption[]>;
}

export interface AgentProviderDeviceCodeStartResponse {
  userCode: string;
  deviceAuthId: string;
  interval: number;
  verificationUrl: string;
}

export interface AgentProviderDeviceCodePollResponse {
  status: 'pending' | 'success';
  error?: string;
  accountId?: string;
}

export interface AgentSkillMcpServer {
  id: string;
  name?: string;
  url?: string;
  type?: string;
}

export interface AgentSkillConfig {
  repo: string;
  name: string;
  description?: string;
  instructions?: string;
  content?: string;
  enabled: boolean;
  system?: boolean;
  mcpServers?: AgentSkillMcpServer[];
  nixPackages?: string[];
  permissions?: string[];
}

export interface AgentSkillsCatalogItem {
  skillId: string;
  repo: string;
  name: string;
  description?: string;
  instructions?: string;
  hidden: boolean;
  mcpServers?: AgentSkillMcpServer[];
  nixPackages?: string[];
  permissions?: string[];
  installed: boolean;
}

export interface AgentSkillsCatalogResponse {
  catalog: AgentSkillsCatalogItem[];
  installedSkills: AgentSkillConfig[];
}

export interface AgentSettings {
  model?: string;
  modelSelection?: { mode: 'auto' | 'pinned'; pinnedModel?: string };
  providerModelPreferences?: Record<string, string>;
  networkConfig?: { allowedDomains?: string[]; deniedDomains?: string[] };
  nixConfig?: { packages?: string[] };
  mcpServers?: Record<string, { url?: string }>;
  soulMd?: string;
  userMd?: string;
  identityMd?: string;
  skillsConfig?: { skills: AgentSkillConfig[] };
  toolsConfig?: Record<string, any>;
  pluginsConfig?: Record<string, any>;
  authProfiles?: AgentAuthProfile[];
  installedProviders?: AgentInstalledProvider[];
  verboseLogging?: boolean;
  updatedAt: number;
}

export interface AgentDetail extends AgentItem {
  settings: AgentSettings;
}

export interface AgentConnectionItem {
  id: string;
  platform: string;
  templateAgentId?: string;
  config: Record<string, any>;
  settings: Record<string, any>;
  metadata: Record<string, any>;
  status: 'active' | 'stopped' | 'error';
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformSchema {
  name: string;
  icon: string;
  schema: Record<string, any>;
}

// ============================================================
// URL helpers
// ============================================================

function agentsUrl(orgSlug: string, path = '') {
  return `${API_URL}/api/${orgSlug}/agents${path}`;
}

function lobuAuthUrl(path = '') {
  return `${API_URL}/lobu/api/v1/auth${path}`;
}

async function throwIfNotOk(res: Response, fallbackMessage: string) {
  if (!res.ok) {
    const raw = await res.text();
    let message = `${fallbackMessage}: ${res.status}`;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string; message?: string };
        message = parsed.message || parsed.error || message;
      } catch {
        message = raw;
      }
    }
    throw new Error(message);
  }
}

// ============================================================
// Query hooks
// ============================================================

export function useAgents(options?: { enabled?: boolean }) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agents', slug],
    queryFn: async (): Promise<AgentItem[]> => {
      const res = await fetchWithTimeout(agentsUrl(slug!), {
        credentials: 'include',
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { agents?: AgentItem[] };
      return data.agents ?? [];
    },
    enabled: !!slug && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}

export function useAgent(agentId?: string | null) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agent', slug, agentId],
    queryFn: async (): Promise<AgentDetail> => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}`), {
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to fetch agent');
      return res.json() as Promise<AgentDetail>;
    },
    enabled: !!slug && !!agentId,
    staleTime: 30_000,
  });
}

export function useAgentConfig(agentId?: string | null) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agent-config', slug, agentId],
    queryFn: async (): Promise<AgentSettings> => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/config`), {
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to fetch agent config');
      return res.json() as Promise<AgentSettings>;
    },
    enabled: !!slug && !!agentId,
    staleTime: 30_000,
  });
}

export function useAgentConnections(agentId?: string | null) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agent-connections', slug, agentId],
    queryFn: async (): Promise<AgentConnectionItem[]> => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/connections`), {
        credentials: 'include',
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        connections?: AgentConnectionItem[];
      };
      return data.connections ?? [];
    },
    enabled: !!slug && !!agentId,
    staleTime: 30_000,
  });
}

export function useAgentProviderCatalog(agentId?: string | null) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agent-provider-catalog', slug, agentId],
    queryFn: async (): Promise<AgentProviderCatalogResponse> => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/config/providers/catalog`), {
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to fetch provider catalog');
      return res.json() as Promise<AgentProviderCatalogResponse>;
    },
    enabled: !!slug && !!agentId,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useAgentSkillsCatalog(agentId?: string | null) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['agent-skills-catalog', slug, agentId],
    queryFn: async (): Promise<AgentSkillsCatalogResponse> => {
      const path = agentId ? `/${agentId}/config/skills/catalog` : '/config/skills/catalog';
      const res = await fetchWithTimeout(agentsUrl(slug!, path), { credentials: 'include' });
      await throwIfNotOk(res, 'Failed to fetch skills catalog');
      return res.json() as Promise<AgentSkillsCatalogResponse>;
    },
    enabled: !!slug,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function getAgentProviderOAuthStartUrl(
  orgSlug: string,
  providerId: string,
  agentId: string
) {
  return agentsUrl(orgSlug, `/${agentId}/providers/${providerId}/oauth/start`);
}

export async function startAgentProviderDeviceCode(
  providerId: string,
  agentId: string
): Promise<AgentProviderDeviceCodeStartResponse> {
  const res = await fetchWithTimeout(lobuAuthUrl(`/${providerId}/start`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ agentId }),
  });
  await throwIfNotOk(res, 'Failed to start device code flow');
  return res.json() as Promise<AgentProviderDeviceCodeStartResponse>;
}

export async function pollAgentProviderDeviceCode(
  providerId: string,
  params: { agentId: string; deviceAuthId: string; userCode: string }
): Promise<AgentProviderDeviceCodePollResponse> {
  const res = await fetchWithTimeout(lobuAuthUrl(`/${providerId}/poll`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(params),
  });
  await throwIfNotOk(res, 'Failed to check device code status');
  return res.json() as Promise<AgentProviderDeviceCodePollResponse>;
}

export async function submitAgentProviderOAuthCode(
  orgSlug: string,
  agentId: string,
  providerId: string,
  code: string
): Promise<{ success: boolean }> {
  const res = await fetchWithTimeout(
    agentsUrl(orgSlug, `/${agentId}/providers/${providerId}/oauth/code`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ code }),
    }
  );
  await throwIfNotOk(res, 'Failed to complete OAuth login');
  return res.json() as Promise<{ success: boolean }>;
}

export function useAgentPlatforms() {
  return useQuery({
    queryKey: ['agent-platforms'],
    queryFn: async (): Promise<Record<string, PlatformSchema>> => {
      const res = await fetchWithTimeout(`${API_URL}/api/agents/platforms`, {
        credentials: 'include',
      });
      if (!res.ok) return {};
      const data = (await res.json()) as {
        platforms?: Record<string, PlatformSchema>;
      };
      return data.platforms ?? {};
    },
    staleTime: 60_000,
  });
}

// ============================================================
// Mutation hooks
// ============================================================

export function useCreateAgent() {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { agentId: string; name: string; description?: string }) => {
      const res = await fetchWithTimeout(agentsUrl(slug!), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(params),
      });
      await throwIfNotOk(res, 'Failed to create agent');
      return res.json() as Promise<AgentDetail>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent created');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create agent');
    },
  });
}

export function useUpdateAgent(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { name?: string; description?: string }) => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(params),
      });
      await throwIfNotOk(res, 'Failed to update agent');
      return res.json() as Promise<AgentDetail>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', slug, agentId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update agent');
    },
  });
}

export function useDeleteAgent(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to delete agent');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Agent deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete agent');
    },
  });
}

export function useUpdateAgentConfig(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: Partial<AgentSettings>) => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/config`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(params),
      });
      await throwIfNotOk(res, 'Failed to update agent config');
      return res.json() as Promise<AgentSettings>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agent-config', slug, agentId],
      });
      queryClient.invalidateQueries({
        queryKey: ['agent-provider-catalog', slug, agentId],
      });
      queryClient.invalidateQueries({ queryKey: ['agent', slug, agentId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update agent config');
    },
  });
}

export function useCreateAgentConnection(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      platform: string;
      config?: Record<string, any>;
      settings?: Record<string, any>;
    }) => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/connections`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(params),
      });
      await throwIfNotOk(res, 'Failed to create connection');
      return res.json() as Promise<AgentConnectionItem>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agent-connections', slug, agentId],
      });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Connection created');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create connection');
    },
  });
}

export function useDeleteAgentConnection(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connId: string) => {
      const res = await fetchWithTimeout(agentsUrl(slug!, `/${agentId}/connections/${connId}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to delete connection');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agent-connections', slug, agentId],
      });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      toast.success('Connection deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete connection');
    },
  });
}

export function useStartAgentConnection(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connId: string) => {
      const res = await fetchWithTimeout(
        agentsUrl(slug!, `/${agentId}/connections/${connId}/start`),
        {
          method: 'POST',
          credentials: 'include',
        }
      );
      await throwIfNotOk(res, 'Failed to start connection');
      return res.json() as Promise<AgentConnectionItem>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agent-connections', slug, agentId],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to start connection');
    },
  });
}

export function useStopAgentConnection(agentId: string) {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (connId: string) => {
      const res = await fetchWithTimeout(
        agentsUrl(slug!, `/${agentId}/connections/${connId}/stop`),
        {
          method: 'POST',
          credentials: 'include',
        }
      );
      await throwIfNotOk(res, 'Failed to stop connection');
      return res.json() as Promise<AgentConnectionItem>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['agent-connections', slug, agentId],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to stop connection');
    },
  });
}
