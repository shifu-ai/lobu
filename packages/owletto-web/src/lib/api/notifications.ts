import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, type ApiOrgContext, fetchWithTimeout, resolveApiScope } from './core';

export interface NotificationItem {
  id: number;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  resource_url: string | null;
  is_read: boolean;
  created_at: string;
}

function notificationsUrl(orgContext: ApiOrgContext | string, path = '') {
  const scope = resolveApiScope(orgContext);
  return `${API_URL}/api/${scope.slug}/notifications${path}`;
}

export function useUnreadNotificationCount(orgContext?: ApiOrgContext | string | null) {
  return useQuery({
    queryKey: ['notifications-unread-count', orgContext],
    queryFn: async () => {
      const res = await fetchWithTimeout(notificationsUrl(orgContext!, '/unread-count'), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch unread count');
      const data = (await res.json()) as { count: number };
      return data.count;
    },
    enabled: !!orgContext,
  });
}

export function useNotifications(orgContext?: ApiOrgContext | string | null) {
  return useInfiniteQuery({
    queryKey: ['notifications', orgContext],
    queryFn: async ({ pageParam }: { pageParam: number | null }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', String(pageParam));
      params.set('limit', '20');
      const url = `${notificationsUrl(orgContext!)}?${params}`;
      const res = await fetchWithTimeout(url, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch notifications');
      return res.json() as Promise<{
        notifications: NotificationItem[];
        nextCursor: number | null;
      }>;
    },
    initialPageParam: null as number | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !!orgContext,
  });
}

export function useMarkNotificationRead(orgContext?: ApiOrgContext | string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: number) => {
      const res = await fetchWithTimeout(notificationsUrl(orgContext!, `/${notificationId}/read`), {
        method: 'PATCH',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to mark as read');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead(orgContext?: ApiOrgContext | string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetchWithTimeout(notificationsUrl(orgContext!, '/mark-all-read'), {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to mark all as read');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useDeleteNotification(orgContext?: ApiOrgContext | string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: number) => {
      const res = await fetchWithTimeout(notificationsUrl(orgContext!, `/${notificationId}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete notification');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
