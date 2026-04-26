import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { API_URL } from './api/core';

/**
 * Subscribes to server-sent invalidation events for the given org.
 * When the backend emits an `invalidate` event (e.g. after a template update via MCP),
 * this hook invalidates the corresponding React Query cache keys so the UI refreshes.
 */
export function useInvalidationSSE(orgSlug: string | null | undefined) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelay = useRef(1000);

  useEffect(() => {
    if (!orgSlug) return;

    let disposed = false;

    function connect() {
      const url = `${API_URL}/api/${orgSlug}/events`;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;

      es.addEventListener('invalidate', (e) => {
        reconnectDelay.current = 1000; // reset backoff on successful message
        try {
          const data = JSON.parse(e.data) as { keys?: string[] };
          if (data.keys) {
            for (const key of data.keys) {
              queryClient.invalidateQueries({ queryKey: [key] });
            }
          }
        } catch {
          // Ignore malformed events
        }
      });

      es.onerror = () => {
        console.warn('[SSE] Connection error, reconnecting in %dms...', reconnectDelay.current);
        es.close();
        esRef.current = null;

        if (disposed) return;

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (!disposed) {
            connect();
          }
        }, reconnectDelay.current);

        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
      };
    }

    connect();

    return () => {
      disposed = true;
      esRef.current?.close();
      esRef.current = null;
      if (reconnectTimeoutRef.current != null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      reconnectDelay.current = 1000;
    };
  }, [orgSlug, queryClient]);
}
