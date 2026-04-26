import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { API_URL, fetchWithTimeout, getPathScope } from './core';

export interface ConnectedClientItem {
  id: string;
  kind: 'mcp' | 'messaging';
  title?: string | null;
  identifier?: string | null;
  platform?: string | null;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
  status: string;
  authState: string;
  lastSeenAt?: number | null;
  userAgent?: string | null;
  capabilities?: Record<string, unknown> | null;
  externalUrl?: string | null;
  linkedUserName?: string | null;
  linkedUserEmail?: string | null;
  details?: Record<string, unknown> | null;
}

function clientsUrl(orgSlug: string, path = '', params?: URLSearchParams) {
  const base = `${API_URL}/api/${orgSlug}/clients${path}`;
  const qs = params?.toString();
  return qs ? `${base}?${qs}` : base;
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

export function useConnectedClients(
  agentId?: string | null,
  options?: { enabled?: boolean }
) {
  const { slug } = getPathScope();

  return useQuery({
    queryKey: ['connected-clients', slug, agentId ?? null],
    queryFn: async (): Promise<ConnectedClientItem[]> => {
      const params = new URLSearchParams();
      if (agentId) params.set('agentId', agentId);

      const res = await fetchWithTimeout(clientsUrl(slug!, '', params), {
        credentials: 'include',
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { clients?: ConnectedClientItem[] };
      return data.clients ?? [];
    },
    enabled: !!slug && (options?.enabled ?? true),
    staleTime: 15_000,
  });
}

export function useDisconnectMcpClient() {
  const { slug } = getPathScope();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (clientId: string) => {
      const res = await fetchWithTimeout(clientsUrl(slug!, `/mcp/${clientId}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      await throwIfNotOk(res, 'Failed to revoke MCP client');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connected-clients'] });
      queryClient.invalidateQueries({ queryKey: ['oauth-agents'] });
      toast.success('MCP client revoked');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to revoke MCP client');
    },
  });
}
