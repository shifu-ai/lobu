/**
 * Watcher Summary View component
 * Displays aggregated data and classification stats
 */

import { AlertTriangle, Check, Copy, Layers } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  type EntityContext,
  type PendingAnalysis,
  useWatcherEventReferences,
  type WatcherWindow,
} from '@/hooks/use-watchers';
import { mergeWindows } from '@/lib/aggregation';
import type { JsonNode } from '@/lib/json-renderer';
import { JsonRenderer as TemplateRenderer } from '@/lib/json-renderer';
import type { ClassificationContext, IdReferenceItem, TrendDirection } from './json-renderer';
import { JsonRenderer as AutoRenderer } from './json-renderer';

interface WatcherSummaryViewProps {
  windows: WatcherWindow[];
  jsonTemplate?: unknown;
  entityId?: number;
  organizationId: string;
  ownerSlug?: string;
  pendingAnalysis?: PendingAnalysis;
  entityContext?: EntityContext;
  watcherName?: string;
  watcherId?: string | number;
}

// Color palette matching the stacked area chart
const CLASSIFICATION_COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
];

/**
 * Compute trend directions by comparing latest window vs previous window classification_stats
 */
function computeTrends(windows: WatcherWindow[]): Record<string, Record<string, TrendDirection>> {
  if (windows.length < 2) return {};

  const sorted = [...windows].sort(
    (a, b) => new Date(a.window_start).getTime() - new Date(b.window_start).getTime()
  );

  const latest = sorted[sorted.length - 1].classification_stats ?? {};
  const previous = sorted[sorted.length - 2].classification_stats ?? {};

  const trends: Record<string, Record<string, TrendDirection>> = {};

  for (const classifierSlug of new Set([...Object.keys(latest), ...Object.keys(previous)])) {
    trends[classifierSlug] = {};
    const latestValues = latest[classifierSlug] ?? {};
    const previousValues = previous[classifierSlug] ?? {};

    for (const value of new Set([...Object.keys(latestValues), ...Object.keys(previousValues)])) {
      const curr = latestValues[value] ?? 0;
      const prev = previousValues[value] ?? 0;
      if (curr > prev) trends[classifierSlug][value] = 'up';
      else if (curr < prev) trends[classifierSlug][value] = 'down';
      else trends[classifierSlug][value] = 'stable';
    }
  }

  return trends;
}

/**
 * Build a color map for all classification values
 */
function buildColorMap(stats: Record<string, Record<string, number>>): Record<string, string> {
  const colors: Record<string, string> = {};
  let colorIndex = 0;
  for (const values of Object.values(stats)) {
    for (const value of Object.keys(values)) {
      if (!(value in colors)) {
        colors[value] = CLASSIFICATION_COLORS[colorIndex % CLASSIFICATION_COLORS.length];
        colorIndex++;
      }
    }
  }
  return colors;
}

function collectReferenceIds(value: unknown, parentKey: string | null, collector: Set<number>) {
  if (Array.isArray(value)) {
    if (
      parentKey?.toLowerCase().endsWith('_ids') &&
      value.every((item) => typeof item === 'number' || /^[0-9]+$/.test(String(item)))
    ) {
      for (const item of value) {
        const id = typeof item === 'number' ? item : Number.parseInt(String(item), 10);
        if (Number.isFinite(id) && id > 0) {
          collector.add(Math.trunc(id));
        }
      }
      return;
    }

    for (const item of value) {
      collectReferenceIds(item, parentKey, collector);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectReferenceIds(child, key, collector);
    }
  }
}

export function WatcherSummaryView({
  windows,
  jsonTemplate,
  entityId,
  organizationId,
  ownerSlug,
  pendingAnalysis,
  entityContext,
  watcherName,
  watcherId,
}: WatcherSummaryViewProps) {
  const aggregated = useMemo(() => mergeWindows(windows), [windows]);

  // Compute classification stats from windows
  const classificationStats = useMemo(() => {
    const stats: Record<string, Record<string, number>> = {};

    for (const window of windows) {
      if (window.classification_stats) {
        for (const [classifierSlug, values] of Object.entries(window.classification_stats)) {
          if (!stats[classifierSlug]) {
            stats[classifierSlug] = {};
          }
          for (const [value, count] of Object.entries(values)) {
            stats[classifierSlug][value] = (stats[classifierSlug][value] || 0) + count;
          }
        }
      }
    }

    return stats;
  }, [windows]);

  const trends = useMemo(() => computeTrends(windows), [windows]);
  const colorMap = useMemo(() => buildColorMap(classificationStats), [classificationStats]);

  const classificationContext: ClassificationContext | undefined = useMemo(() => {
    if (Object.keys(classificationStats).length === 0) return undefined;
    return { stats: classificationStats, trends, colors: colorMap };
  }, [classificationStats, trends, colorMap]);

  const referenceIds = useMemo(() => {
    const ids = new Set<number>();
    collectReferenceIds(aggregated.data, null, ids);
    return Array.from(ids);
  }, [aggregated.data]);

  const { data: referenceItems } = useWatcherEventReferences(
    entityId,
    referenceIds,
    organizationId,
    ownerSlug
  );

  const idReferences = useMemo<Record<number, IdReferenceItem>>(() => {
    const map: Record<number, IdReferenceItem> = {};
    for (const item of referenceItems || []) {
      map[item.id] = item;
    }
    return map;
  }, [referenceItems]);

  const [copied, setCopied] = useState(false);

  const agentPrompt = useMemo(() => {
    if (!watcherId) return null;
    const name = watcherName ? `"${watcherName}"` : 'watcher';
    const count = pendingAnalysis?.unprocessed_count;
    const countStr = count ? `There are ${count} unprocessed items. ` : '';
    return `Run the watcher analysis for ${name} (watcher_id: ${watcherId}). ${countStr}Use get_watcher to check status, then process with read_knowledge and complete_window tools.`;
  }, [watcherId, watcherName, pendingAnalysis?.unprocessed_count]);

  const handleCopy = useCallback(async () => {
    if (!agentPrompt) return;
    try {
      await navigator.clipboard.writeText(agentPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  }, [agentPrompt]);

  if (windows.length === 0) {
    const hasPending = pendingAnalysis && pendingAnalysis.unprocessed_count > 0;
    const hasContext = !!entityContext;
    const ranges = pendingAnalysis?.unprocessed_ranges?.filter((r) => r.unprocessed_content > 0);

    if (!hasPending && !hasContext) {
      return (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Layers className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">No analysis data</p>
          <p className="text-sm mt-1">Analysis results will appear here once generated</p>
        </div>
      );
    }

    return (
      <div className="flex items-start justify-center pt-8 pb-12">
        <Card className="w-full max-w-lg">
          <CardContent className="px-5 py-5 space-y-5">
            {/* Prominent pending count */}
            {hasPending && (
              <div className="text-center space-y-1">
                <div className="text-4xl font-bold tabular-nums">
                  {pendingAnalysis.unprocessed_count}
                </div>
                <p className="text-sm text-muted-foreground">items ready for analysis</p>
              </div>
            )}

            {/* Entity context + ranges as compact stats row */}
            {(hasContext || (ranges && ranges.length > 0)) && (
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-muted-foreground border-t pt-4">
                {hasContext && (
                  <>
                    <span>
                      <span className="font-medium text-foreground">
                        {entityContext.active_connections}
                      </span>{' '}
                      connectors
                    </span>
                    <span className="text-border">|</span>
                    <span>
                      <span className="font-medium text-foreground">
                        {entityContext.total_content.toLocaleString()}
                      </span>{' '}
                      total knowledge
                    </span>
                    {entityContext.latest_content_date && (
                      <>
                        <span className="text-border">|</span>
                        <span>
                          latest{' '}
                          <span className="font-medium text-foreground">
                            {new Date(entityContext.latest_content_date).toLocaleDateString()}
                          </span>
                        </span>
                      </>
                    )}
                  </>
                )}
                {ranges && ranges.length > 0 && (
                  <>
                    {hasContext && <span className="basis-full h-0" />}
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {ranges.map((range) => (
                        <span
                          key={range.month}
                          className="rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs"
                        >
                          {range.month}{' '}
                          <span className="font-medium text-foreground">
                            {range.unprocessed_content.toLocaleString()}
                          </span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Agent prompt */}
            {agentPrompt && (
              <div className="space-y-2 border-t pt-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Run with your AI agent
                </p>
                <div className="relative">
                  <code className="block rounded-md bg-muted px-3 py-2 pr-16 text-xs leading-relaxed whitespace-pre-wrap break-words">
                    {agentPrompt}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCopy}
                    className="absolute top-1 right-1 h-7 text-xs"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {aggregated.metadata.skippedIncompatibleWindows != null &&
        aggregated.metadata.skippedIncompatibleWindows > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {aggregated.metadata.skippedIncompatibleWindows} older{' '}
              {aggregated.metadata.skippedIncompatibleWindows === 1 ? 'window was' : 'windows were'}{' '}
              excluded because{' '}
              {aggregated.metadata.skippedIncompatibleWindows === 1 ? 'it uses' : 'they use'} a
              previous template version.
            </span>
          </div>
        )}

      {jsonTemplate ? (
        <TemplateRenderer template={{ root: jsonTemplate as JsonNode }} data={aggregated.data} />
      ) : (
        <AutoRenderer
          data={aggregated.data}
          classificationContext={classificationContext}
          idReferences={idReferences}
          showSectionSidebar
        />
      )}
    </div>
  );
}
