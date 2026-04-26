import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export function CollapsibleFormSection({
  title,
  description,
  open,
  onOpenChange,
  titleMeta,
  headerAction,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titleMeta?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-start gap-2 pr-3">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/20"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{title}</h3>
                {titleMeta}
              </div>
              {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
            </div>
            <ChevronRight
              className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
        </CollapsibleTrigger>
        {headerAction ? (
          <div className="flex shrink-0 items-center self-center">{headerAction}</div>
        ) : null}
      </div>
      <CollapsibleContent>
        <div className="space-y-4 border-t px-4 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
