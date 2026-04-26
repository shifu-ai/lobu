import { Bell } from 'lucide-react';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useOrgContext } from '@/hooks/use-org-context';
import { useUnreadNotificationCount } from '@/lib/api/notifications';
import { cn } from '@/lib/utils';
import { NotificationPanel } from './notification-panel';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { orgContext, isAuthenticated } = useOrgContext();
  const { data: count } = useUnreadNotificationCount(isAuthenticated ? orgContext : null);

  if (!isAuthenticated) return null;

  const displayCount = count && count > 0 ? (count > 99 ? '99+' : String(count)) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative flex items-center justify-center h-8 w-8 rounded-md transition-colors',
            'text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
          )}
        >
          <Bell className="h-4 w-4" />
          {displayCount && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-medium leading-none text-white bg-destructive rounded-full">
              {displayCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" sideOffset={8}>
        <NotificationPanel onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
