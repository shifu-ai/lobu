import { useNavigate } from '@tanstack/react-router';
import { BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOrgContext } from '@/hooks/use-org-context';
import type { NotificationItem as NotificationItemType } from '@/lib/api/notifications';
import {
  useDeleteNotification,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/lib/api/notifications';
import { NotificationItem } from './notification-item';

function groupByDate(notifications: NotificationItemType[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: { label: string; items: NotificationItemType[] }[] = [];
  const todayItems: NotificationItemType[] = [];
  const yesterdayItems: NotificationItemType[] = [];
  const earlierItems: NotificationItemType[] = [];

  for (const n of notifications) {
    const date = new Date(n.created_at);
    date.setHours(0, 0, 0, 0);
    if (date.getTime() === today.getTime()) {
      todayItems.push(n);
    } else if (date.getTime() === yesterday.getTime()) {
      yesterdayItems.push(n);
    } else {
      earlierItems.push(n);
    }
  }

  if (todayItems.length > 0) groups.push({ label: 'Today', items: todayItems });
  if (yesterdayItems.length > 0) groups.push({ label: 'Yesterday', items: yesterdayItems });
  if (earlierItems.length > 0) groups.push({ label: 'Earlier', items: earlierItems });
  return groups;
}

interface NotificationPanelProps {
  onClose: () => void;
}

export function NotificationPanel({ onClose }: NotificationPanelProps) {
  const { orgContext } = useOrgContext();
  const navigate = useNavigate();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotifications(orgContext);
  const markRead = useMarkNotificationRead(orgContext);
  const markAllRead = useMarkAllNotificationsRead(orgContext);
  const deleteNotification = useDeleteNotification(orgContext);

  const allNotifications = data?.pages.flatMap((p) => p.notifications) ?? [];
  const groups = groupByDate(allNotifications);

  const handleClick = (notification: NotificationItemType) => {
    if (!notification.is_read) {
      markRead.mutate(notification.id);
    }
    if (notification.resource_url) {
      navigate({ to: notification.resource_url });
      onClose();
    }
  };

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    deleteNotification.mutate(id);
  };

  return (
    <div className="flex flex-col max-h-[min(480px,70vh)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <h3 className="font-semibold text-sm">Notifications</h3>
        {allNotifications.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
          >
            Mark all read
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <BellOff className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">No notifications</p>
          </div>
        ) : (
          <div className="py-1">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((n) => (
                  <NotificationItem
                    key={n.id}
                    notification={n}
                    onClick={() => handleClick(n)}
                    onDelete={(e) => handleDelete(e, n.id)}
                  />
                ))}
              </div>
            ))}
            {hasNextPage && (
              <div className="px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
