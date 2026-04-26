import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { EntityTypeAuditEntry } from '@/lib/api';

export function actionBadgeVariant(
  action: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (action) {
    case 'create':
      return 'default';
    case 'update':
      return 'secondary';
    case 'delete':
      return 'destructive';
    default:
      return 'outline';
  }
}

export function actionLabel(action: string): string {
  switch (action) {
    case 'create':
      return 'Created';
    case 'update':
      return 'Updated';
    case 'delete':
      return 'Deleted';
    default:
      return action;
  }
}

export function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

export function JsonDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!before && !after) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {before && (
            <div>
              <p className="text-[10px] uppercase text-muted-foreground font-medium mb-1">Before</p>
              <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-48">
                {JSON.stringify(before, null, 2)}
              </pre>
            </div>
          )}
          {after && (
            <div>
              <p className="text-[10px] uppercase text-muted-foreground font-medium mb-1">After</p>
              <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-48">
                {JSON.stringify(after, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AuditEntryItem({ entry }: { entry: EntityTypeAuditEntry }) {
  return (
    <div className="relative pl-6 pb-6 last:pb-0">
      {/* Timeline dot */}
      <div className="absolute left-0 top-1.5 h-3 w-3 rounded-full border-2 border-border bg-background" />
      {/* Timeline line */}
      <div className="absolute left-[5px] top-5 bottom-0 w-px bg-border last:hidden" />

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant={actionBadgeVariant(entry.action)}>{actionLabel(entry.action)}</Badge>
          {entry.actor && <span className="text-xs text-muted-foreground">{entry.actor}</span>}
        </div>
        <p className="text-xs text-muted-foreground">{formatTimestamp(entry.created_at)}</p>

        {entry.action === 'update' && (
          <JsonDiff before={entry.before_payload} after={entry.after_payload} />
        )}
        {entry.action === 'create' && entry.after_payload && (
          <JsonDiff before={null} after={entry.after_payload} />
        )}
        {entry.action === 'delete' && entry.before_payload && (
          <JsonDiff before={entry.before_payload} after={null} />
        )}
      </div>
    </div>
  );
}
