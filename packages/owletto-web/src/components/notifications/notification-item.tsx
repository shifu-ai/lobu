import { Bell, Bot, GitPullRequest, Link2, Mail, Trash2 } from 'lucide-react';
import type { NotificationItem as NotificationItemType } from '@/lib/api/notifications';
import { cn } from '@/lib/utils';

function typeIcon(type: string, isRead: boolean) {
  if (!isRead) {
    return <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />;
  }
  const iconClass = 'h-4 w-4 text-muted-foreground shrink-0';
  switch (type) {
    case 'action_approval_needed':
      return <GitPullRequest className={iconClass} />;
    case 'connection_permission_request':
      return <Link2 className={iconClass} />;
    case 'invitation_received':
      return <Mail className={iconClass} />;
    case 'agent_message':
      return <Bot className={iconClass} />;
    default:
      return <Bell className={iconClass} />;
  }
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

interface NotificationItemProps {
  notification: NotificationItemType;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

export function NotificationItem({ notification, onClick, onDelete }: NotificationItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent',
        !notification.is_read && 'bg-accent/50'
      )}
    >
      <div className="mt-1">{typeIcon(notification.type, notification.is_read)}</div>
      <div className="flex-1 min-w-0">
        <p className={cn('truncate', !notification.is_read && 'font-medium')}>
          {notification.title}
        </p>
        {notification.body && (
          <p className="text-muted-foreground text-xs line-clamp-2 mt-0.5">{notification.body}</p>
        )}
        <p className="text-muted-foreground text-xs mt-1">
          {relativeTime(notification.created_at)}
        </p>
      </div>
      <button
        type="button"
        onClick={onDelete}
        className="mt-1 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </button>
  );
}
