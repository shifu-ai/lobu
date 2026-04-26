import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ConnectorDefinitionItem, FeedItem, FeedRunItem } from '@/lib/api';
import {
  useConnectorDefinitions,
  useDeleteFeed,
  useFeedDetail,
  useTriggerFeed,
  useUpdateFeed,
} from '@/lib/api';
import { formatDuration, formatShortDate, formatTimeAgo } from '@/lib/format-utils';
import { getStatusVariant } from '@/lib/status-variants';
import { DynamicConnectorForm } from './dynamic-connector-form';

interface FeedExpandedRowProps {
  feed: FeedItem;
  organizationId: string;
  onEditConnection: (connectionId: number) => void;
}

function getFeedConfigSchema(
  connectorDef: ConnectorDefinitionItem | undefined,
  feedKey: string
): Record<string, unknown> | undefined {
  const feedsSchema = connectorDef?.feeds_schema as Record<
    string,
    { key?: string; configSchema?: Record<string, unknown> }
  > | null;
  if (!feedsSchema) return undefined;

  // 1. Exact match by schema object key
  if (feedsSchema[feedKey]?.configSchema) return feedsSchema[feedKey].configSchema;

  // 2. Match by inner .key property (handles DB key ≠ object key)
  for (const entry of Object.values(feedsSchema)) {
    if (entry?.key === feedKey && entry.configSchema) return entry.configSchema;
  }

  // 3. Single feed type — use it regardless of key mismatch
  const entries = Object.values(feedsSchema);
  if (entries.length === 1 && entries[0]?.configSchema) return entries[0].configSchema;

  return undefined;
}

function RunIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
}

function RunErrorCell({ error }: { error: string }) {
  const [open, setOpen] = useState(false);
  const isLong = error.length > 80;

  if (!isLong) {
    return <span className="text-destructive">{error}</span>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-left text-destructive truncate max-w-[200px] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {error}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 max-h-64 overflow-auto" onClick={(e) => e.stopPropagation()}>
        <pre className="text-xs whitespace-pre-wrap break-words text-destructive">{error}</pre>
      </PopoverContent>
    </Popover>
  );
}

function RunCheckpointCell({ checkpoint }: { checkpoint: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-left text-muted-foreground hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          view
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-h-64 overflow-auto" onClick={(e) => e.stopPropagation()}>
        <pre className="text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(checkpoint, null, 2)}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

function RecentSyncs({ runs }: { runs: FeedRunItem[] }) {
  const [open, setOpen] = useState(false);

  if (runs.length === 0) return null;

  const lastRun = runs[0];
  const hasCheckpoints = runs.some((r) => r.checkpoint);
  const summary = (
    <span className="text-xs text-muted-foreground">
      {lastRun.status === 'completed' ? (
        <>
          Last synced {formatTimeAgo(lastRun.created_at)}
          {lastRun.items_collected ? ` · ${lastRun.items_collected} items` : ''}
        </>
      ) : lastRun.status === 'failed' ? (
        <span className="text-destructive">
          Last sync failed {formatTimeAgo(lastRun.created_at)}
        </span>
      ) : (
        <>
          Syncing...
          {lastRun.items_collected ? ` · ${lastRun.items_collected} items so far` : ''}
        </>
      )}
    </span>
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs hover:text-foreground transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <ChevronRight
            className={`h-3 w-3 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <RunIcon status={lastRun.status} />
          {summary}
          <span className="text-muted-foreground">({runs.length} runs)</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-md border mt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs py-1.5 px-3 w-8" />
                <TableHead className="text-xs py-1.5 px-3">When</TableHead>
                <TableHead className="text-xs py-1.5 px-3">Status</TableHead>
                <TableHead className="text-xs py-1.5 px-3">Items</TableHead>
                <TableHead className="text-xs py-1.5 px-3">Duration</TableHead>
                <TableHead className="text-xs py-1.5 px-3">Version</TableHead>
                {hasCheckpoints && (
                  <TableHead className="text-xs py-1.5 px-3">Checkpoint</TableHead>
                )}
                <TableHead className="text-xs py-1.5 px-3">Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const duration = run.completed_at
                  ? Math.round(
                      (new Date(run.completed_at).getTime() - new Date(run.created_at).getTime()) /
                        1000
                    )
                  : null;
                return (
                  <TableRow key={run.id}>
                    <TableCell className="py-1.5 px-3">
                      <RunIcon status={run.status} />
                    </TableCell>
                    <TableCell
                      className="py-1.5 px-3 text-xs text-muted-foreground"
                      title={formatShortDate(run.created_at)}
                    >
                      {formatTimeAgo(run.created_at)}
                    </TableCell>
                    <TableCell className="py-1.5 px-3 text-xs">
                      <StatusBadge status={getStatusVariant(run.status)}>{run.status}</StatusBadge>
                    </TableCell>
                    <TableCell className="py-1.5 px-3 text-xs font-mono text-muted-foreground">
                      {run.items_collected ?? '—'}
                    </TableCell>
                    <TableCell className="py-1.5 px-3 text-xs text-muted-foreground">
                      {duration != null ? formatDuration(duration) : '—'}
                    </TableCell>
                    <TableCell className="py-1.5 px-3 text-xs font-mono text-muted-foreground">
                      {run.connector_version ?? '—'}
                    </TableCell>
                    {hasCheckpoints && (
                      <TableCell className="py-1.5 px-3 text-xs">
                        {run.checkpoint ? (
                          <RunCheckpointCell checkpoint={run.checkpoint} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="py-1.5 px-3 text-xs">
                      {run.error_message ? <RunErrorCell error={run.error_message} /> : ''}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function FeedExpandedRow({ feed, organizationId, onEditConnection }: FeedExpandedRowProps) {
  const { data: connectorDefs = [] } = useConnectorDefinitions(organizationId);
  const { data: feedDetail, refetch } = useFeedDetail(feed.id);

  // Auto-refetch while any run is active (running/pending/claimed)
  const hasActiveRun = feedDetail?.recent_runs?.some((r) =>
    ['running', 'pending', 'claimed'].includes(r.status)
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const id = setInterval(() => refetch(), 5000);
    return () => clearInterval(id);
  }, [hasActiveRun, refetch]);
  const updateFeed = useUpdateFeed();
  const triggerFeed = useTriggerFeed();
  const deleteFeed = useDeleteFeed();

  const [configValues, setConfigValues] = useState<Record<string, unknown>>(feed.config ?? {});
  const [dirty, setDirty] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const connectorDef = useMemo(
    () => connectorDefs.find((d) => d.key === feed.connector_key),
    [connectorDefs, feed.connector_key]
  );
  const configSchema = useMemo(
    () => getFeedConfigSchema(connectorDef, feed.feed_key),
    [connectorDef, feed.feed_key]
  );

  useEffect(() => {
    setConfirmingDelete(false);
  }, [feed.id]);

  const handleConfigChange = useCallback((values: Record<string, unknown>) => {
    setConfigValues(values);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    await updateFeed.mutateAsync({ feed_id: feed.id, config: configValues });
    setDirty(false);
  }, [updateFeed, feed.id, configValues]);

  const handleToggleStatus = useCallback(async () => {
    const nextStatus = feed.status === 'active' ? 'paused' : 'active';
    await updateFeed.mutateAsync({ feed_id: feed.id, status: nextStatus });
  }, [updateFeed, feed.id, feed.status]);

  const handleTrigger = useCallback(async () => {
    await triggerFeed.mutateAsync(feed.id);
  }, [triggerFeed, feed.id]);

  const isActive = feed.status === 'active';
  const authIssue = feed.auth_profile_status && feed.auth_profile_status !== 'active';
  const isBusy = updateFeed.isPending || triggerFeed.isPending || deleteFeed.isPending;

  return (
    <div className="p-4 space-y-4">
      {/* Auth warning */}
      {authIssue && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-sm">
          <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
          <span className="text-amber-700 dark:text-amber-400">
            Authentication issue: {feed.auth_profile_status}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onEditConnection(feed.connection_id);
            }}
          >
            Fix Auth
          </Button>
        </div>
      )}

      {/* Sync controls + edit/delete */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={(e) => {
            e.stopPropagation();
            void handleToggleStatus();
          }}
        >
          {isActive ? (
            <Pause className="h-3.5 w-3.5 mr-1.5" />
          ) : (
            <Play className="h-3.5 w-3.5 mr-1.5" />
          )}
          {isActive ? 'Pause' : 'Resume'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={isBusy || !isActive}
          onClick={(e) => {
            e.stopPropagation();
            void handleTrigger();
          }}
        >
          {triggerFeed.isPending ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          )}
          Sync Now
        </Button>

        {dirty && (
          <Button
            size="sm"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              void handleSave();
            }}
          >
            {updateFeed.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            Save
          </Button>
        )}

        <div className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onEditConnection(feed.connection_id);
          }}
        >
          Edit Connection
        </Button>

        {confirmingDelete ? (
          <div
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="destructive"
              size="sm"
              disabled={isBusy}
              onClick={() => {
                deleteFeed.mutate(feed.id, {
                  onSettled: () => setConfirmingDelete(false),
                });
              }}
            >
              {deleteFeed.isPending ? 'Deleting...' : 'Delete'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={deleteFeed.isPending}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={isBusy}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete
          </Button>
        )}
      </div>

      {/* Recent syncs */}
      {feedDetail?.recent_runs && feedDetail.recent_runs.length > 0 && (
        <RecentSyncs runs={feedDetail.recent_runs} />
      )}

      {/* Config form */}
      {configSchema && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Settings className="h-3.5 w-3.5" />
            Configuration
          </div>
          <DynamicConnectorForm
            schema={configSchema}
            initialValues={feed.config ?? undefined}
            onValuesChange={handleConfigChange}
          />
        </div>
      )}

      {/* Connection info */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          Connection:{' '}
          <span className="text-foreground">{feed.connection_name || feed.connector_key}</span>
        </span>
        {feed.connection_status && (
          <StatusBadge status={getStatusVariant(feed.connection_status)} showDot>
            {feed.connection_status}
          </StatusBadge>
        )}
      </div>
    </div>
  );
}
