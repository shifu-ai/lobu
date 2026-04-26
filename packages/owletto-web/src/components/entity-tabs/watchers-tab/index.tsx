import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useTabFilters } from '@/hooks/use-tab-filters';
import {
  type PartialWatcherFilters,
  parseWatcherFiltersFromUrl,
  serializeWatcherFiltersToSearch,
} from '@/lib/watchers-filters';
import { WatcherDetail } from './watcher-detail';
import { WatcherGroupDetail } from './watcher-group-detail';
import { WatchersList } from './watchers-list';

interface WatchersTabProps {
  organizationId: string;
  ownerSlug?: string; // Required for org-wide mode drill-down links
  entityId?: number; // Optional - undefined means org-wide mode
  entityName?: string;
  watcherId?: string; // From path: /entity/watchers/172
  defaultCreateOpen?: boolean;
  onItemName?: (name: string | null) => void;
}

export function WatchersTab({
  organizationId,
  ownerSlug,
  entityId,
  entityName,
  watcherId,
  defaultCreateOpen,
  onItemName,
}: WatchersTabProps) {
  // Org-wide mode when entityId is undefined
  const isOrgWide = entityId === undefined;
  const navigate = useNavigate();
  const location = useLocation();

  const { filters: urlFilters, updateFilters } = useTabFilters<PartialWatcherFilters>({
    parse: parseWatcherFiltersFromUrl,
    serialize: serializeWatcherFiltersToSearch,
    filterKeys: ['since', 'until', 'granularity', 'version', 'entityIds'],
  });

  // Compute the base path for the entity (pathname without /watchers or /watchers/{id})
  const basePath = useMemo(() => {
    const pathname = location.pathname;
    const insightsDetailMatch = pathname.match(/^(.+)\/watchers\/[^/]+$/);
    if (insightsDetailMatch) return insightsDetailMatch[1];
    const insightsMatch = pathname.match(/^(.+)\/watchers$/);
    if (insightsMatch) return insightsMatch[1];
    return pathname;
  }, [location.pathname]);

  // Handle selecting an watcher from the list — navigate to path-based URL
  const handleSelectInsight = useCallback(
    (id: string) => {
      navigate({
        to: `${basePath}/watchers/${id}` as '/',
        search: {},
      });
    },
    [navigate, basePath]
  );

  if (!watcherId) {
    return (
      <WatchersList
        organizationId={organizationId}
        ownerSlug={ownerSlug}
        entityId={entityId}
        entityName={entityName}
        isOrgWide={isOrgWide}
        onSelectWatcher={handleSelectInsight}
        defaultCreateOpen={defaultCreateOpen}
      />
    );
  }

  if (isOrgWide) {
    return (
      <WatcherGroupDetail
        groupId={watcherId}
        organizationId={organizationId}
        ownerSlug={ownerSlug}
        filters={urlFilters}
        onFiltersChange={updateFilters}
        onItemName={onItemName}
      />
    );
  }

  return (
    <WatcherDetail
      watcherId={watcherId}
      entityId={entityId}
      organizationId={organizationId}
      ownerSlug={ownerSlug}
      filters={urlFilters}
      onFiltersChange={updateFilters}
      onItemName={onItemName}
    />
  );
}

export { GranularitySelector } from './granularity-selector';
export { JsonRenderer } from './json-renderer';
export { WatcherDetail } from './watcher-detail';
export { WatcherSummaryView } from './watcher-summary-view';
export { WatcherTimelineView } from './watcher-timeline-view';
// Export sub-components for potential direct use
export { WatchersList } from './watchers-list';
