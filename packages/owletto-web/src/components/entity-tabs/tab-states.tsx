import type { LucideIcon } from 'lucide-react';
import { AlertCircle, Loader2, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function TabLoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading {label}...
    </div>
  );
}

export function TabErrorState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-destructive">
      <AlertCircle className="mr-2 h-4 w-4" />
      Failed to load {label}
    </div>
  );
}

export function TabEmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Icon className="h-12 w-12 mb-4 opacity-50" />
      <p className="text-lg font-medium">{title}</p>
      <p className="text-sm mt-1">{description}</p>
      {children}
      {actionLabel && onAction && (
        <Button variant="outline" className="mt-4" onClick={onAction}>
          <Plus className="mr-2 h-4 w-4" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
