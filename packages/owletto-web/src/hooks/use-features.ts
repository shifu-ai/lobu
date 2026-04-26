import { useQuery } from '@tanstack/react-query';
import { API_URL, fetchWithTimeout } from '@/lib/api/core';

interface Features {
  agents: boolean;
  lobuEmbedded: boolean;
}

const DEFAULT_FEATURES: Features = { agents: false, lobuEmbedded: false };

/** Runtime feature detection — checks if the agent gateway is available. */
export function useFeatures(): Features {
  const { data } = useQuery({
    queryKey: ['features'],
    queryFn: async (): Promise<Features> => {
      const res = await fetchWithTimeout(`${API_URL}/api/features`);
      if (!res.ok) return DEFAULT_FEATURES;
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return data ?? DEFAULT_FEATURES;
}
