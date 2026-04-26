import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ChevronRight,
  Clock,
  Hash,
  Layers,
  Loader2,
  Pencil,
  Play,
  Send,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { useFeatures } from '@/hooks/use-features';
import {
  type CorrectionInput,
  type FeedbackEntry,
  type TimeGranularity,
  useGetFeedback,
  usePublicWatcherDetail,
  useSubmitFeedback,
  useTriggerWatcher,
  useWatcherDetail,
  type WatcherMetadata,
  type WatcherWindow,
} from '@/hooks/use-watchers';
import {
  formatDateRange,
  formatWindowDateRange,
  getAvailableGranularities,
} from '@/lib/aggregation';
import { useAuthState } from '@/lib/auth-state';
import type { JsonSchema } from '@jsonforms/core';
import { FieldFeedbackProvider } from '@/lib/editable-field/context';
import type { FieldCorrection } from '@/lib/editable-field/editable-primitive';
import { formatTimeAgo } from '@/lib/format-utils';
import type { JsonNode } from '@/lib/json-renderer';
import { JsonRenderer as TemplateRenderer } from '@/lib/json-renderer';
import { inferWatcherGranularityFromSchedule } from '@/lib/watcher-time';
import type { PartialWatcherFilters } from '@/lib/watchers-filters';
import { CreateWatcherSheet } from './create-watcher-sheet';
import { GranularitySelector } from './granularity-selector';
import { JsonRenderer as AutoRenderer } from './json-renderer';
import { NoWindowsEmptyState } from './no-windows-empty-state';
import { WatcherSummaryView } from './watcher-summary-view';

interface WatcherDetailProps {
  watcherId: string;
  entityId?: number;
  organizationId: string;
  ownerSlug?: string;
  filters: PartialWatcherFilters;
  onFiltersChange: (updates: Partial<PartialWatcherFilters>) => void;
  onItemName?: (name: string | null) => void;
}

export function WatcherDetail({
  watcherId,
  entityId,
  organizationId,
  ownerSlug,
  filters,
  onFiltersChange,
  onItemName,
}: WatcherDetailProps) {
  const router = useRouter();
  const location = useLocation();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthState();
  const queryOptions = {
    since: filters.since,
    until: filters.until,
    granularity: filters.granularity,
    templateVersion: filters.version,
  };
  const authQuery = useWatcherDetail(
    watcherId,
    entityId,
    isAuthenticated ? organizationId : undefined,
    queryOptions
  );
  const publicQuery = usePublicWatcherDetail(
    !isAuthenticated ? ownerSlug : undefined,
    watcherId,
    entityId,
    queryOptions
  );
  const { data, isLoading, error } = isAuthenticated ? authQuery : publicQuery;

  useEffect(() => {
    onItemName?.(data?.watcher?.watcher_name ?? null);
    return () => onItemName?.(null);
  }, [data?.watcher?.watcher_name, onItemName]);

  const { agents, lobuEmbedded } = useFeatures();
  const triggerWatcher = useTriggerWatcher();

  const availableGranularities = useMemo(() => {
    if (!data?.watcher) return undefined;
    const baseGranularity = inferWatcherGranularityFromSchedule(data.watcher.schedule);
    return getAvailableGranularities(baseGranularity as TimeGranularity);
  }, [data?.watcher]);

  const windows = data?.windows || [];
  const hasMultipleWindows = windows.length > 1;
  const pendingAnalysis = data?.pending_analysis;

  const watcherMeta = data?.watcher as WatcherMetadata | undefined;
  const canRunNow = Boolean(isAuthenticated && lobuEmbedded && watcherMeta?.agent_id);

  const jsonTemplate = useMemo(() => {
    const raw = watcherMeta?.json_template;
    if (!raw) return undefined;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    return raw;
  }, [watcherMeta]);

  const sortedWindows = useMemo(
    () =>
      [...windows].sort(
        (a, b) => new Date(b.window_start).getTime() - new Date(a.window_start).getTime()
      ),
    [windows]
  );

  const dataDateRangePlaceholder = useMemo(() => {
    if (sortedWindows.length === 0) return undefined;
    const last = sortedWindows[sortedWindows.length - 1];
    const first = sortedWindows[0];
    return formatDateRange(
      new Date(last.window_start),
      new Date(first.window_end || first.window_start)
    );
  }, [sortedWindows]);

  const totalWindowCount = windows.length;
  const totalContentCount = useMemo(
    () => windows.reduce((sum, w) => sum + (w.content_analyzed || 0), 0),
    [windows]
  );

  const warnings = data?.warnings || [];
  const warningNotice =
    warnings.length > 0 ? (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        {warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </span>
    ) : null;

  const handleDateRangeChange = (range: { from?: Date; to?: Date } | undefined) => {
    if (range?.from && range?.to) {
      onFiltersChange({
        since: range.from.toISOString().split('T')[0],
        until: range.to.toISOString().split('T')[0],
      });
    } else {
      onFiltersChange({
        since: undefined,
        until: undefined,
      });
    }
  };

  const handleOpenContents = (windowId: number) => {
    // Navigate to the Knowledge (events) tab with window_id filter
    const pathname = location.pathname;
    const basePath = pathname.replace(/\/watchers(\/[^/]+)?$/, '');
    navigate({
      to: `${basePath}/events` as '/',
      search: { window_id: windowId },
    });
  };

  const lastAnalyzedAt = useMemo(() => {
    if (sortedWindows.length === 0) return null;
    return new Date(sortedWindows[0].created_at);
  }, [sortedWindows]);

  const [editSheetOpen, setEditSheetOpen] = useState(false);

  const editingData = useMemo(() => {
    if (!watcherMeta) return undefined;
    return {
      watcher_id: watcherMeta.watcher_id,
      entity_id: entityId,
      name: watcherMeta.watcher_name,
      slug: watcherMeta.slug,
      description: watcherMeta.description,
      prompt: watcherMeta.prompt,
      extraction_schema: watcherMeta.extraction_schema,
      json_template: watcherMeta.json_template,
      sources: watcherMeta.sources,
      schedule: watcherMeta.schedule ?? undefined,
      reaction_script: watcherMeta.reaction_script,
      scheduler_client_id: watcherMeta.scheduler_client_id,
      agent_id: watcherMeta.agent_id,
    };
  }, [watcherMeta, entityId]);

  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isServiceUnavailable = errorMessage.includes('503');

    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 mb-4 text-destructive" />
        <p className="text-lg font-medium text-destructive">
          {isServiceUnavailable ? 'Service temporarily unavailable' : 'Failed to load watcher'}
        </p>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">
          {isServiceUnavailable
            ? 'The watchers service is currently unavailable. Please try again in a few moments.'
            : errorMessage}
        </p>
        <Button variant="outline" onClick={() => router.history.back()} className="mt-4">
          Go back
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-12 w-48 rounded bg-muted animate-pulse" />
        <div className="h-10 w-full rounded bg-muted animate-pulse" />
        <div className="h-64 w-full rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="space-y-2 my-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <DateRangePicker
            value={
              filters.since && filters.until
                ? {
                    from: new Date(filters.since),
                    to: new Date(filters.until),
                  }
                : undefined
            }
            onChange={handleDateRangeChange}
            placeholder={dataDateRangePlaceholder ?? 'Pick a date range'}
          />
          <GranularitySelector
            value={filters.granularity ?? 'auto'}
            onChange={(g) => onFiltersChange({ granularity: g })}
            availableGranularities={availableGranularities}
            placeholder="Auto"
            className="w-36"
          />
          {warningNotice}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-4 text-xs text-muted-foreground leading-relaxed">
          <span className="flex items-center gap-1">
            <Hash className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">
              {totalContentCount.toLocaleString()}
            </span>
            knowledge analyzed in{' '}
            <span className="font-medium text-foreground">{totalWindowCount}</span>{' '}
            {totalWindowCount === 1 ? 'window' : 'windows'}
          </span>
          {lastAnalyzedAt && (
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              Last analyzed {formatTimeAgo(lastAnalyzedAt)}
            </span>
          )}
          {pendingAnalysis && pendingAnalysis.unprocessed_count > 0 && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <Clock className="h-3.5 w-3.5" />
              {pendingAnalysis.unprocessed_count} pending analysis
            </span>
          )}
          {watcherMeta?.schedule && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Schedule</span>
              <span className="font-mono text-foreground">{watcherMeta.schedule}</span>
            </span>
          )}
          {watcherMeta?.scheduler_client_id && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">External client</span>
              <Badge variant="outline" className="font-mono text-[11px]">
                {watcherMeta.scheduler_client_id}
              </Badge>
            </span>
          )}
          {watcherMeta?.agent_id && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Agent</span>
              <Badge variant="outline" className="font-mono text-[11px]">
                {watcherMeta.agent_id}
              </Badge>
            </span>
          )}
          {watcherMeta?.next_run_at && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Next run</span>
              <span className="text-foreground">{formatTimeAgo(watcherMeta.next_run_at)}</span>
            </span>
          )}
          {watcherMeta?.watcher_run && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Run</span>
              <Badge
                variant={
                  watcherMeta.watcher_run.status === 'failed'
                    ? 'destructive'
                    : watcherMeta.watcher_run.status === 'completed'
                      ? 'secondary'
                      : 'outline'
                }
                className="font-mono text-[11px]"
              >
                {watcherMeta.watcher_run.status}
              </Badge>
            </span>
          )}
          {canRunNow && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => triggerWatcher.mutate(watcherId)}
              disabled={triggerWatcher.isPending}
            >
              {triggerWatcher.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Run now
            </Button>
          )}
          {isAuthenticated && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => setEditSheetOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </div>
        {watcherMeta?.watcher_run?.error_message && watcherMeta.watcher_run.status === 'failed' ? (
          <p className="text-xs text-destructive">{watcherMeta.watcher_run.error_message}</p>
        ) : null}
      </div>

      {/* Content */}
      <WindowTimeline
        windows={sortedWindows}
        jsonTemplate={jsonTemplate}
        extractionSchema={watcherMeta?.extraction_schema}
        onOpenContents={handleOpenContents}
        watcherId={watcherId}
        isAuthenticated={isAuthenticated}
        emptyState={
          <NoWindowsEmptyState
            ownerSlug={ownerSlug}
            showAgentsCta={Boolean(isAuthenticated && agents && ownerSlug)}
          />
        }
        summaryView={
          hasMultipleWindows ? (
            <WatcherSummaryView
              windows={windows}
              jsonTemplate={jsonTemplate}
              entityId={entityId}
              organizationId={organizationId}
              ownerSlug={ownerSlug}
              pendingAnalysis={pendingAnalysis}
              entityContext={data?.entity_context}
              watcherName={data?.watcher?.watcher_name}
              watcherId={watcherId}
            />
          ) : undefined
        }
      />

      {isAuthenticated && (
        <CreateWatcherSheet
          open={editSheetOpen}
          onOpenChange={setEditSheetOpen}
          organizationId={organizationId}
          entityId={entityId}
          editingWatcher={editingData}
        />
      )}
    </div>
  );
}

function getWindowSummary(window: WatcherWindow): string | null {
  const data = window.extracted_data;
  if (!data || typeof data !== 'object') return null;
  if (typeof (data as Record<string, unknown>).summary === 'string') {
    return (data as Record<string, unknown>).summary as string;
  }
  return null;
}

/**
 * Locally staged correction. One row per (windowId, fieldPath); structural
 * edits ('remove' / 'add') sit alongside value edits ('set') and submit as a
 * single batch of CorrectionInput entries.
 */
interface PendingCorrection {
  mutation: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
}

type WindowPending = Record<string, PendingCorrection>;

export function WindowTimeline({
  windows,
  jsonTemplate,
  extractionSchema,
  onOpenContents,
  summaryView,
  watcherId,
  isAuthenticated,
  renderWindowLabelPrefix,
  emptyState,
}: {
  windows: WatcherWindow[];
  jsonTemplate?: unknown;
  extractionSchema?: Record<string, unknown>;
  onOpenContents: (windowId: number) => void;
  summaryView?: ReactNode;
  watcherId?: string;
  isAuthenticated?: boolean;
  renderWindowLabelPrefix?: (window: WatcherWindow) => ReactNode;
  emptyState?: ReactNode;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  // Pending corrections per window keyed by field path. Structural mutations
  // and value edits share the same staging shape so submit sends one batch.
  const [pendingByWindow, setPendingByWindow] = useState<Record<number, WindowPending>>({});
  const submitFeedback = useSubmitFeedback();
  const feedbackQuery = useGetFeedback(watcherId, undefined, {
    enabled: !!watcherId && !!isAuthenticated,
  });

  const stageSet = useCallback((windowId: number, fieldPath: string, newValue: unknown) => {
    setPendingByWindow((prev) => ({
      ...prev,
      [windowId]: {
        ...prev[windowId],
        [fieldPath]: { ...prev[windowId]?.[fieldPath], mutation: 'set', value: newValue },
      },
    }));
  }, []);

  const stageStructural = useCallback(
    (windowId: number, fieldPath: string, mutation: 'remove' | 'add', value?: unknown) => {
      setPendingByWindow((prev) => ({
        ...prev,
        [windowId]: {
          ...prev[windowId],
          [fieldPath]: { ...prev[windowId]?.[fieldPath], mutation, value },
        },
      }));
    },
    []
  );

  const updatePendingNote = useCallback(
    (windowId: number, fieldPath: string, note: string) => {
      setPendingByWindow((prev) => {
        const existing = prev[windowId]?.[fieldPath];
        if (!existing) return prev;
        return {
          ...prev,
          [windowId]: {
            ...prev[windowId],
            [fieldPath]: { ...existing, note: note || undefined },
          },
        };
      });
    },
    []
  );

  const discardPending = useCallback((windowId: number, fieldPath: string) => {
    setPendingByWindow((prev) => {
      const windowPending = prev[windowId];
      if (!windowPending) return prev;
      const next = { ...windowPending };
      delete next[fieldPath];
      return { ...prev, [windowId]: next };
    });
  }, []);

  const handleSubmitCorrections = useCallback(
    (windowId: number) => {
      const windowPending = pendingByWindow[windowId];
      if (!windowPending || Object.keys(windowPending).length === 0 || !watcherId) return;

      const corrections: CorrectionInput[] = Object.entries(windowPending).map(
        ([field_path, p]) => ({
          field_path,
          mutation: p.mutation,
          ...(p.mutation !== 'remove' ? { value: p.value } : {}),
          ...(p.note ? { note: p.note } : {}),
        })
      );

      submitFeedback.mutate(
        { watcher_id: watcherId, window_id: windowId, corrections },
        {
          onSuccess: () => {
            setPendingByWindow((prev) => {
              const next = { ...prev };
              delete next[windowId];
              return next;
            });
          },
        }
      );
    },
    [pendingByWindow, watcherId, submitFeedback]
  );

  const toggleWindow = (windowId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(windowId)) next.delete(windowId);
      else next.add(windowId);
      return next;
    });
  };

  if (windows.length === 0) {
    return (
      <div>
        {emptyState ?? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center text-muted-foreground">
            <Layers className="mb-4 h-12 w-12 opacity-50" />
            <p className="text-lg font-medium text-foreground">No analysis windows yet</p>
            <p className="mt-1 text-sm">Windows will appear here once analysis is complete.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Summary — above the timeline, no dot */}
      {summaryView && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setSummaryExpanded(!summaryExpanded)}
            className="group w-full text-left"
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground group-hover:text-foreground transition-colors">
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 transition-transform ${summaryExpanded ? 'rotate-90' : ''}`}
              />
              <Layers className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium text-foreground">Summary</span>
              <span>·</span>
              <span>Across all {windows.length} windows</span>
            </div>
          </button>
          <AnimatePresence initial={false}>
            {summaryExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="pt-3 ml-[22px]">{summaryView}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Window timeline */}
      <div>
        {windows.map((window, index) => {
          const dateLabel = formatWindowDateRange(
            window.window_start,
            window.window_end,
            window.granularity
          );
          const isExpanded = expandedIds.has(window.window_id);
          const summary = getWindowSummary(window);
          const isLast = index === windows.length - 1;

          return (
            <div key={window.window_id} className="flex gap-3">
              {/* Timeline gutter: dot + connecting line */}
              <div className="flex flex-col items-center shrink-0 w-4">
                <div
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border transition-colors ${
                    isExpanded ? 'border-primary bg-primary' : 'border-border bg-muted'
                  }`}
                />
                {!isLast && (
                  <motion.div
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                    className="flex-1 w-[2px] origin-top bg-border mt-1"
                  />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 pb-4">
                <button
                  type="button"
                  onClick={() => toggleWindow(window.window_id)}
                  className="group w-full text-left"
                >
                  <div className="flex items-center gap-2 text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    />
                    {renderWindowLabelPrefix?.(window)}
                    <span className="font-medium text-foreground">{dateLabel}</span>
                    <span>·</span>
                    <span>{window.content_analyzed} items</span>
                    {window.created_at && (
                      <>
                        <span>·</span>
                        <span>{formatTimeAgo(window.created_at)}</span>
                      </>
                    )}
                  </div>
                  {!isExpanded && summary && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1 ml-[22px]">
                      {summary}
                    </p>
                  )}
                </button>

                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <WindowBody
                        window={window}
                        jsonTemplate={jsonTemplate}
                        extractionSchema={extractionSchema}
                        watcherId={watcherId}
                        isAuthenticated={isAuthenticated}
                        feedback={feedbackQuery.data}
                        pending={pendingByWindow[window.window_id]}
                        onSet={stageSet}
                        onStructural={stageStructural}
                        onUpdateNote={updatePendingNote}
                        onDiscard={discardPending}
                        onSubmit={handleSubmitCorrections}
                        onOpenContents={onOpenContents}
                        submitting={submitFeedback.isPending}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Build the latest-per-field correction map for a window so the renderer can
 * show "edited" indicators inline. Server already orders feedback recent
 * first, so we walk it once and keep the first hit per field path.
 */
function buildCorrectionMap(
  windowId: number,
  feedback: FeedbackEntry[] | undefined
): Record<string, FieldCorrection> {
  if (!feedback) return {};
  const map: Record<string, FieldCorrection> = {};
  for (const entry of feedback) {
    if (entry.window_id !== windowId) continue;
    if (entry.mutation !== 'set') continue; // structural mutations don't replace a leaf value
    if (map[entry.field_path]) continue;
    map[entry.field_path] = {
      value: entry.corrected_value,
      note: entry.note,
      author: entry.created_by,
      createdAt: entry.created_at,
      mutation: entry.mutation,
    };
  }
  return map;
}

function pendingValueMap(pending: WindowPending | undefined): Record<string, unknown> {
  if (!pending) return {};
  const out: Record<string, unknown> = {};
  for (const [path, p] of Object.entries(pending)) {
    if (p.mutation === 'set') out[path] = p.value;
  }
  return out;
}

interface WindowBodyProps {
  window: WatcherWindow;
  jsonTemplate?: unknown;
  extractionSchema?: Record<string, unknown>;
  watcherId?: string;
  isAuthenticated?: boolean;
  feedback: FeedbackEntry[] | undefined;
  pending: WindowPending | undefined;
  onSet: (windowId: number, fieldPath: string, value: unknown) => void;
  onStructural: (
    windowId: number,
    fieldPath: string,
    mutation: 'remove' | 'add',
    value?: unknown
  ) => void;
  onUpdateNote: (windowId: number, fieldPath: string, note: string) => void;
  onDiscard: (windowId: number, fieldPath: string) => void;
  onSubmit: (windowId: number) => void;
  onOpenContents: (windowId: number) => void;
  submitting: boolean;
}

function WindowBody({
  window,
  jsonTemplate,
  extractionSchema,
  watcherId,
  isAuthenticated,
  feedback,
  pending,
  onSet,
  onStructural,
  onUpdateNote,
  onDiscard,
  onSubmit,
  onOpenContents,
  submitting,
}: WindowBodyProps) {
  const editable = !!(isAuthenticated && watcherId);
  const corrections = useMemo(
    () => buildCorrectionMap(window.window_id, feedback),
    [window.window_id, feedback]
  );
  const pendingValues = useMemo(() => pendingValueMap(pending), [pending]);
  const windowFeedback = useMemo(
    () => (feedback ?? []).filter((f) => f.window_id === window.window_id),
    [feedback, window.window_id]
  );
  const pendingCount = pending ? Object.keys(pending).length : 0;

  const handleSet = useCallback(
    (path: string, value: unknown) => onSet(window.window_id, path, value),
    [onSet, window.window_id]
  );
  const handleStructural = useCallback(
    (path: string, mutation: 'remove' | 'add', value?: unknown) =>
      onStructural(window.window_id, path, mutation, value),
    [onStructural, window.window_id]
  );

  return (
    <div className="space-y-3 pt-3">
      <WindowExecutionMeta window={window} />
      <FieldFeedbackProvider corrections={corrections} pendingCorrections={pendingValues}>
        {window.extracted_data && Object.keys(window.extracted_data).length > 0 ? (
          jsonTemplate ? (
            <TemplateRenderer
              template={{ root: jsonTemplate as JsonNode }}
              data={window.extracted_data}
              onCorrection={editable ? handleSet : undefined}
            />
          ) : (
            <AutoRenderer
              data={window.extracted_data}
              onCorrection={editable ? handleSet : undefined}
              onStructuralCorrection={editable ? handleStructural : undefined}
              extractionSchema={extractionSchema as JsonSchema | undefined}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">No data extracted</p>
        )}
      </FieldFeedbackProvider>

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="link"
          size="sm"
          className="p-0 h-auto text-xs"
          onClick={() => onOpenContents(window.window_id)}
        >
          View {window.content_analyzed} source items
        </Button>
        {pendingCount > 0 && (
          <Badge variant="outline" className="text-xs">
            {pendingCount} pending {pendingCount === 1 ? 'correction' : 'corrections'}
          </Badge>
        )}
      </div>

      {pendingCount > 0 && pending ? (
        <PendingCorrectionsPanel
          pending={pending}
          extractedData={window.extracted_data}
          onUpdateNote={(path, note) => onUpdateNote(window.window_id, path, note)}
          onDiscard={(path) => onDiscard(window.window_id, path)}
          onSubmit={() => onSubmit(window.window_id)}
          submitting={submitting}
        />
      ) : null}

      {windowFeedback.length > 0 ? <PastCorrectionsPanel feedback={windowFeedback} /> : null}
    </div>
  );
}

function originalAtPath(data: Record<string, unknown> | undefined, path: string): unknown {
  if (!data) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function PendingCorrectionsPanel({
  pending,
  extractedData,
  onUpdateNote,
  onDiscard,
  onSubmit,
  submitting,
}: {
  pending: WindowPending;
  extractedData: Record<string, unknown> | undefined;
  onUpdateNote: (path: string, note: string) => void;
  onDiscard: (path: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const entries = Object.entries(pending);
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          Pending corrections — not yet submitted
        </p>
        <Button size="sm" className="h-7 px-3 text-xs" onClick={onSubmit} disabled={submitting}>
          <Send className="h-3.5 w-3.5 mr-1" />
          Submit {entries.length}
        </Button>
      </div>
      <div className="space-y-2">
        {entries.map(([path, p]) => {
          const original = originalAtPath(extractedData, path);
          return (
            <div key={path} className="rounded-sm border bg-background p-2 space-y-1.5">
              <div className="flex items-start gap-2">
                <Badge variant="secondary" className="text-[10px] uppercase">
                  {p.mutation}
                </Badge>
                <span className="font-mono text-xs">{path}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-5 w-5 p-0 text-muted-foreground"
                  title="Discard"
                  onClick={() => onDiscard(path)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              {p.mutation !== 'remove' ? (
                <div className="text-xs space-y-0.5">
                  {p.mutation === 'set' ? (
                    <div>
                      <span className="text-muted-foreground">Was: </span>
                      <span className="font-mono">{JSON.stringify(original) ?? '—'}</span>
                    </div>
                  ) : null}
                  <div>
                    <span className="text-muted-foreground">
                      {p.mutation === 'add' ? 'New item' : 'Now'}:{' '}
                    </span>
                    <span className="font-mono">{JSON.stringify(p.value)}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Item will be flagged for removal.</p>
              )}
              <textarea
                placeholder="Optional: why?"
                value={p.note ?? ''}
                onChange={(e) => onUpdateNote(path, e.target.value)}
                rows={1}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PastCorrectionsPanel({ feedback }: { feedback: FeedbackEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border bg-muted/20">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span>
          {feedback.length} past correction{feedback.length === 1 ? '' : 's'}
        </span>
      </button>
      {open ? (
        <div className="px-3 pb-3 space-y-1.5">
          {feedback.map((entry) => (
            <div key={entry.id} className="rounded-sm border bg-background p-2 text-xs space-y-0.5">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">
                  {entry.mutation}
                </Badge>
                <span className="font-mono">{entry.field_path}</span>
                {entry.mutation !== 'remove' ? (
                  <span className="font-mono">→ {JSON.stringify(entry.corrected_value)}</span>
                ) : null}
              </div>
              {entry.note ? <div className="text-muted-foreground">{entry.note}</div> : null}
              <div className="text-[11px] text-muted-foreground">
                {entry.created_by} · {formatTimeAgo(entry.created_at)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WindowExecutionMeta({ window }: { window: WatcherWindow }) {
  const hasMetadata =
    !!window.model_used || !!window.client_id || Object.keys(window.run_metadata ?? {}).length > 0;

  if (!hasMetadata) return null;

  return (
    <div className="flex flex-wrap items-start gap-2 text-xs text-muted-foreground">
      {window.model_used ? (
        <Badge variant="secondary" className="font-mono">
          {window.model_used}
        </Badge>
      ) : null}
      {window.client_id ? (
        <span>
          Client: <span className="font-mono text-foreground">{window.client_id}</span>
        </span>
      ) : null}
      {window.run_metadata && Object.keys(window.run_metadata).length > 0 ? (
        <details className="cursor-pointer">
          <summary className="list-none underline underline-offset-2">Run metadata</summary>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground">
            {JSON.stringify(window.run_metadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
