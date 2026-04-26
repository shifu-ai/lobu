import { Badge } from '@/components/ui/badge';
import type { AvailableOperationItem } from '@/lib/api/connections';

// ============================================================
// Feeds Panel
// ============================================================

interface FeedEntry {
  name?: string;
  description?: string;
}

export function FeedsPanel({
  feedsSchema,
  enabledFeeds,
  onToggleFeed,
}: {
  feedsSchema: Record<string, unknown> | null;
  enabledFeeds?: Set<string>;
  onToggleFeed?: (key: string, enabled: boolean) => void;
}) {
  if (!feedsSchema) return null;
  const entries = Object.entries(feedsSchema as Record<string, FeedEntry>);
  if (entries.length === 0) return null;

  const interactive = !!enabledFeeds && !!onToggleFeed;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Feeds</p>
      <div className="space-y-1.5">
        {entries.map(([key, feed]) =>
          interactive ? (
            <label key={key} className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={enabledFeeds.has(key)}
                onChange={(e) => onToggleFeed(key, e.target.checked)}
                className="rounded border-input mt-0.5"
              />
              <div>
                <span className="font-medium">{feed.name ?? key}</span>
                {feed.description && (
                  <p className="text-xs text-muted-foreground">{feed.description}</p>
                )}
              </div>
            </label>
          ) : (
            <div key={key} className="text-sm">
              <span className="font-medium">{feed.name ?? key}</span>
              {feed.description && (
                <p className="text-xs text-muted-foreground">{feed.description}</p>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ============================================================
// Actions Panel
// ============================================================

export function ActionsPanel({
  operations,
  autoApproveActions,
  requireApprovalActions,
  onToggleAction,
}: {
  operations: AvailableOperationItem[];
  autoApproveActions?: Set<string> | string[];
  requireApprovalActions?: Set<string> | string[];
  onToggleAction?: (key: string, autoApprove: boolean) => void;
}) {
  if (operations.length === 0) return null;

  const approveSet =
    autoApproveActions instanceof Set ? autoApproveActions : new Set(autoApproveActions ?? []);
  const requireSet =
    requireApprovalActions instanceof Set
      ? requireApprovalActions
      : new Set(requireApprovalActions ?? []);
  const interactive = !!onToggleAction;

  const isAutoApproved = (op: AvailableOperationItem) => {
    if (op.requires_approval) return approveSet.has(op.operation_key);
    return !requireSet.has(op.operation_key);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</p>
      <div className="space-y-1.5">
        {operations.map((op) => {
          const autoApproved = isAutoApproved(op);
          const requiresApproval = op.requires_approval || requireSet.has(op.operation_key);

          if (interactive) {
            return (
              <label
                key={op.operation_key}
                className="flex items-start gap-2 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={autoApproved}
                  onChange={(e) => onToggleAction(op.operation_key, e.target.checked)}
                  className="rounded border-input mt-0.5"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span>{op.name ?? op.operation_key}</span>
                    <ApprovalBadge
                      requiresApproval={requiresApproval}
                      isAutoApproved={autoApproved}
                    />
                  </div>
                  {op.description && (
                    <p className="text-xs text-muted-foreground">{op.description}</p>
                  )}
                </div>
              </label>
            );
          }

          return (
            <div key={op.operation_key} className="text-sm">
              <div className="flex items-center gap-2">
                <span>{op.name ?? op.operation_key}</span>
                <ApprovalBadge requiresApproval={requiresApproval} isAutoApproved={autoApproved} />
              </div>
              {op.description && <p className="text-xs text-muted-foreground">{op.description}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ApprovalBadge({
  requiresApproval,
  isAutoApproved,
}: {
  requiresApproval: boolean;
  isAutoApproved: boolean;
}) {
  if (!requiresApproval) return null;
  if (isAutoApproved) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 h-4 text-emerald-600 border-emerald-300"
      >
        Auto-approved
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1.5 py-0 h-4 text-amber-600 border-amber-300"
    >
      Requires approval
    </Badge>
  );
}

// ============================================================
// Static actions list from actions_schema (for uninstalled connector preview)
// ============================================================

export function ActionsSchemaPanel({
  actionsSchema,
}: {
  actionsSchema: Record<string, unknown> | null;
}) {
  if (!actionsSchema) return null;
  const entries = Object.entries(
    actionsSchema as Record<
      string,
      { name?: string; description?: string; requiresApproval?: boolean }
    >
  );
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</p>
      <div className="space-y-1.5">
        {entries.map(([key, action]) => (
          <div key={key} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{action.name ?? key}</span>
              {action.requiresApproval && (
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 h-4 text-amber-600 border-amber-300"
                >
                  Requires approval
                </Badge>
              )}
            </div>
            {action.description && (
              <p className="text-xs text-muted-foreground">{action.description}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
