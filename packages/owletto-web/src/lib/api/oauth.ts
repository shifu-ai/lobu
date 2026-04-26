import { useQuery } from '@tanstack/react-query';
import { API_URL, fetchWithTimeout } from './core';

export interface OAuthAgent {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  software_id?: string;
  software_version?: string;
  scope?: string;
  redirect_uris: string[];
  grant_types?: string[];
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  user_name?: string;
  user_email?: string;
  active_token_count: number;
}

export function useOAuthAgents(orgSlug?: string | null) {
  return useQuery({
    queryKey: ['oauth-agents', orgSlug],
    queryFn: async () => {
      const response = await fetchWithTimeout(
        `${API_URL}/api/agents?org_slug=${encodeURIComponent(orgSlug!)}`,
        { credentials: 'include' }
      );
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const result = (await response.json()) as { agents?: OAuthAgent[] };
      return result.agents ?? [];
    },
    enabled: !!orgSlug,
  });
}
