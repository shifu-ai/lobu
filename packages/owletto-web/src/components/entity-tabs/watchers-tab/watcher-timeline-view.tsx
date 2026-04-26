/**
 * Watcher Timeline View component
 * Displays windows in an Aceternity Timeline format
 */

import { ExternalLink, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Timeline } from '@/components/ui/timeline';
import type { WatcherWindow } from '@/hooks/use-watchers';
import { formatWindowDateRange } from '@/lib/aggregation';
import { formatTimeAgo } from '@/lib/format-utils';
import type { JsonNode } from '@/lib/json-renderer';
import { JsonRenderer as TemplateRenderer } from '@/lib/json-renderer';
import type { ClassificationContext } from './json-renderer';
import { JsonRenderer as AutoRenderer } from './json-renderer';

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

function buildWindowClassificationContext(
  stats: Record<string, Record<string, number>> | undefined
): ClassificationContext | undefined {
  if (!stats || Object.keys(stats).length === 0) return undefined;
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
  return { stats, trends: {}, colors };
}

interface WatcherTimelineViewProps {
  windows: WatcherWindow[];
  onOpenContents: (windowId: number) => void;
  jsonTemplate?: unknown;
}

export function WatcherTimelineView({
  windows,
  onOpenContents,
  jsonTemplate,
}: WatcherTimelineViewProps) {
  // Sort windows by date (newest first)
  const sortedWindows = useMemo(
    () =>
      [...windows].sort(
        (a, b) => new Date(b.window_start).getTime() - new Date(a.window_start).getTime()
      ),
    [windows]
  );

  const timelineData = useMemo(
    () =>
      sortedWindows.map((window) => ({
        title: formatWindowDateRange(window.window_start, window.window_end, window.granularity),
        content: (
          <div className="space-y-4">
            {/* Window metadata */}
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                <strong className="text-foreground">{window.content_analyzed}</strong> items
                analyzed
              </span>
              {window.created_at && (
                <>
                  <span>•</span>
                  <span>analyzed {formatTimeAgo(window.created_at)}</span>
                </>
              )}
              {window.execution_time_ms && (
                <>
                  <span>•</span>
                  <span>{(window.execution_time_ms / 1000).toFixed(1)}s</span>
                </>
              )}
            </div>

            {/* Granularity badge */}
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs capitalize">
                {window.granularity}
              </Badge>
              {window.is_rollup && (
                <Badge variant="secondary" className="text-xs">
                  Rollup
                </Badge>
              )}
            </div>

            {/* Extracted data */}
            {window.extracted_data && Object.keys(window.extracted_data).length > 0 && (
              <div className="mt-4">
                {jsonTemplate ? (
                  <TemplateRenderer
                    template={{ root: jsonTemplate as JsonNode }}
                    data={window.extracted_data}
                  />
                ) : (
                  <AutoRenderer
                    data={window.extracted_data}
                    classificationContext={buildWindowClassificationContext(
                      window.classification_stats
                    )}
                  />
                )}
              </div>
            )}

            {/* View source content button */}
            <Button
              variant="link"
              size="sm"
              className="p-0 h-auto"
              onClick={() => onOpenContents(window.window_id)}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              View {window.content_analyzed} source items
            </Button>
          </div>
        ),
      })),
    [sortedWindows, onOpenContents, jsonTemplate]
  );

  if (windows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Layers className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No analysis windows</p>
        <p className="text-sm mt-1">Timeline will appear once analysis is complete</p>
      </div>
    );
  }

  return <Timeline data={timelineData} />;
}
