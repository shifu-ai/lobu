import { useNavigate } from '@tanstack/react-router';
import { AlertCircle, Clock, Hash, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { useFeatures } from '@/hooks/use-features';
import { useWatcherGroupDetail, type WatcherGroupDetailResult } from '@/hooks/use-watchers';
import { useAuthState } from '@/lib/auth-state';
import { formatTimeAgo } from '@/lib/format-utils';
import type { PartialWatcherFilters } from '@/lib/watchers-filters';
import { buildEntityTabUrl } from '../types';
import { EntityMultiSelector } from './entity-multi-selector';
import { GranularitySelector } from './granularity-selector';
import { NoWindowsEmptyState } from './no-windows-empty-state';
import { WindowTimeline } from './watcher-detail';
import { WatcherSummaryView } from './watcher-summary-view';

interface WatcherGroupDetailProps {
  groupId: string;
  organizationId: string;
  ownerSlug?: string;
  filters: PartialWatcherFilters;
  onFiltersChange: (updates: Partial<PartialWatcherFilters>) => void;
  onItemName?: (name: string | null) => void;
}

export function WatcherGroupDetail({
  groupId,
  organizationId,
  ownerSlug,
  filters,
  onFiltersChange,
  onItemName,
}: WatcherGroupDetailProps) {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthState();
  const { agents } = useFeatures();
  const { data, availableAssignments, isLoading, isContentLoading, error } = useWatcherGroupDetail({
    groupId,
    organizationId,
    ownerSlug,
    isAuthenticated,
    filters: {
      since: filters.since,
      until: filters.until,
      granularity: filters.granularity,
      templateVersion: filters.version,
      entityIds: filters.entityIds,
    },
  });

  const displayedContentRef = useRef<Pick<
    WatcherGroupDetailResult,
    'windows' | 'json_template'
  > | null>(null);
  const previousGroupIdRef = useRef<string | undefined>(groupId);

  useEffect(() => {
    onItemName?.(data?.group.name ?? null);
    return () => onItemName?.(null);
  }, [data?.group.name, onItemName]);

  if (previousGroupIdRef.current !== groupId) {
    previousGroupIdRef.current = groupId;
    displayedContentRef.current = null;
  }

  if (data && !isContentLoading) {
    displayedContentRef.current = {
      windows: data.windows,
      json_template: data.json_template,
    };
  }

  const assignmentEntities = useMemo(() => {
    const unique = new Map<
      number,
      {
        id: number;
        name: string;
        entityType: string;
        navigationPath?: string;
      }
    >();

    for (const assignment of availableAssignments) {
      const navigationPath =
        ownerSlug && assignment.entity_type && assignment.entity_slug
          ? `${buildEntityTabUrl(
              ownerSlug,
              {
                entityId: assignment.entity_id,
                entityName: assignment.entity_name,
                entityType: assignment.entity_type,
                entitySlug: assignment.entity_slug,
                parentEntityType: assignment.parent_entity_type,
                parentEntitySlug: assignment.parent_slug,
              },
              'watchers'
            )}/${assignment.watcher_id}`
          : undefined;

      unique.set(assignment.entity_id, {
        id: assignment.entity_id,
        name: assignment.entity_name,
        entityType: assignment.entity_type,
        navigationPath,
      });
    }

    return Array.from(unique.values());
  }, [availableAssignments, ownerSlug]);

  const selectedFilterEntities = useMemo(() => {
    const selectedIds = new Set(filters.entityIds ?? []);
    return assignmentEntities.filter((entity) => selectedIds.has(entity.id));
  }, [assignmentEntities, filters.entityIds]);

  const versionBreakdown = useMemo(() => {
    const counts = new Map<number, number>();
    for (const assignment of availableAssignments) {
      const version = assignment.version ?? 0;
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.version - a.version);
  }, [availableAssignments]);

  const latestVersion = versionBreakdown[0]?.version;
  const assignmentsBehindLatest = useMemo(() => {
    if (latestVersion == null) return 0;
    return availableAssignments.filter((assignment) => (assignment.version ?? 0) < latestVersion)
      .length;
  }, [availableAssignments, latestVersion]);

  const lineageSummary = useMemo(() => {
    const roots = availableAssignments.filter(
      (assignment) => assignment.source_watcher_id == null
    ).length;
    return {
      roots,
      derived: Math.max(availableAssignments.length - roots, 0),
    };
  }, [availableAssignments]);

  const displayedContent = displayedContentRef.current;
  const windows = data?.windows ?? [];
  const visibleWindows = isContentLoading && displayedContent ? displayedContent.windows : windows;
  const visibleJsonTemplate =
    isContentLoading && displayedContent ? displayedContent.json_template : data?.json_template;
  const showContentOverlay = isContentLoading && visibleWindows.length > 0;

  const totalContentCount = useMemo(
    () => visibleWindows.reduce((sum, window) => sum + (window.content_analyzed || 0), 0),
    [visibleWindows]
  );

  const selectedAssignmentsCount = data?.assignments.length ?? 0;
  const totalAssignmentsCount = availableAssignments.length;
  const lastAnalyzedAt = visibleWindows[0]?.created_at;

  const handleDateRangeChange = (range: { from?: Date; to?: Date } | undefined) => {
    if (range?.from && range?.to) {
      onFiltersChange({
        since: range.from.toISOString().split('T')[0],
        until: range.to.toISOString().split('T')[0],
      });
      return;
    }

    onFiltersChange({ since: undefined, until: undefined });
  };

  const handleOpenContents = (windowId: number) => {
    if (!ownerSlug) return;
    void navigate({
      to: `/${ownerSlug}/events` as '/',
      search: { window_id: windowId },
    });
  };

  if (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-12 w-12 mb-4 text-destructive" />
        <p className="text-lg font-medium text-destructive">Failed to load watcher</p>
        <p className="text-sm text-muted-foreground mt-2 max-w-md">{errorMessage}</p>
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

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <AlertCircle className="h-10 w-10 mb-3" />
        <p className="text-lg font-medium text-foreground">Watcher not found</p>
        <p className="text-sm mt-1">We couldn&apos;t resolve this watcher group.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 my-4">
        <div className="space-y-2">
          {data.group.description ? (
            <p className="text-sm text-muted-foreground max-w-3xl">{data.group.description}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-4 text-xs text-muted-foreground leading-relaxed">
            <span className="flex items-center gap-1">
              <Hash className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">
                {totalContentCount.toLocaleString()}
              </span>
              knowledge analyzed in{' '}
              <span className="font-medium text-foreground">{visibleWindows.length}</span>{' '}
              {visibleWindows.length === 1 ? 'window' : 'windows'}
            </span>
            <span>
              <span className="font-medium text-foreground">{data.group.assignments_count}</span>{' '}
              assignments
            </span>
            <span>
              <span className="font-medium text-foreground">
                {data.group.active_assignments_count}
              </span>{' '}
              active
            </span>
            {data.group.schedule ? (
              <span className="flex items-center gap-1">
                <span className="text-muted-foreground">Schedule</span>
                <span className="font-mono text-foreground">{data.group.schedule}</span>
              </span>
            ) : null}
            {lastAnalyzedAt ? (
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Last analyzed {formatTimeAgo(lastAnalyzedAt)}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {latestVersion != null && latestVersion > 0 ? (
              <Badge variant="secondary">Latest version: v{latestVersion}</Badge>
            ) : null}
            {versionBreakdown.map(({ version, count }) => (
              <Badge key={version} variant={version === latestVersion ? 'default' : 'outline'}>
                v{version || '?'} · {count}
              </Badge>
            ))}
            {assignmentsBehindLatest > 0 ? (
              <Badge variant="outline">{assignmentsBehindLatest} behind latest</Badge>
            ) : null}
            {lineageSummary.derived > 0 ? (
              <Badge variant="outline">{lineageSummary.derived} derived assignments</Badge>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-start gap-2 text-sm">
            <DateRangePicker
              value={
                filters.since && filters.until
                  ? { from: new Date(filters.since), to: new Date(filters.until) }
                  : undefined
              }
              onChange={handleDateRangeChange}
              placeholder="Pick a date range"
            />
            <GranularitySelector
              value={filters.granularity ?? 'auto'}
              onChange={(granularity) => onFiltersChange({ granularity })}
              placeholder="Auto"
              className="w-36"
            />
            <EntityMultiSelector
              organizationId={organizationId}
              entities={assignmentEntities}
              value={filters.entityIds ?? []}
              onChange={(entityIds) => onFiltersChange({ entityIds })}
            />
          </div>

          {selectedFilterEntities.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Selected entities:</span>
              {selectedFilterEntities.map((entity) =>
                entity.navigationPath ? (
                  <button
                    key={entity.id}
                    type="button"
                    className="inline-flex items-center rounded-full border px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-accent"
                    onClick={() =>
                      void navigate({
                        to: entity.navigationPath as '/',
                      })
                    }
                    title={`Open ${entity.name}`}
                  >
                    {entity.name}
                  </button>
                ) : (
                  <Badge key={entity.id} variant="outline">
                    {entity.name}
                  </Badge>
                )
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              {selectedAssignmentsCount === totalAssignmentsCount
                ? 'Across all watcher assignments in this group.'
                : `Across ${selectedAssignmentsCount} of ${totalAssignmentsCount} selected assignments.`}
            </p>
          </div>
          {isContentLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Updating results…
            </div>
          ) : null}
        </div>

        {isContentLoading && !showContentOverlay ? (
          <div className="space-y-3">
            <div className="h-24 rounded-lg border bg-muted/40 animate-pulse" />
            <div className="h-32 rounded-lg border bg-muted/40 animate-pulse" />
            <div className="h-32 rounded-lg border bg-muted/40 animate-pulse" />
          </div>
        ) : (
          <div className="relative">
            <WindowTimeline
              windows={visibleWindows}
              jsonTemplate={visibleJsonTemplate}
              onOpenContents={handleOpenContents}
              emptyState={
                <NoWindowsEmptyState
                  ownerSlug={ownerSlug}
                  showAgentsCta={Boolean(isAuthenticated && agents && ownerSlug)}
                />
              }
              summaryView={
                visibleWindows.length > 1 ? (
                  <WatcherSummaryView
                    windows={visibleWindows}
                    jsonTemplate={visibleJsonTemplate}
                    organizationId={organizationId}
                    ownerSlug={ownerSlug}
                    watcherName={data.group.name}
                    watcherId={data.group.group_id}
                  />
                ) : undefined
              }
              renderWindowLabelPrefix={(window) =>
                window.entity_name ? (
                  <Badge variant="outline" className="max-w-[220px] truncate">
                    {window.entity_name}
                  </Badge>
                ) : null
              }
            />

            {showContentOverlay ? (
              <div className="absolute inset-0 rounded-lg bg-background/55 backdrop-blur-[1px] pointer-events-none" />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
