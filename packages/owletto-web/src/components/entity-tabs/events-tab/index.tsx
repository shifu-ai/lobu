import { Link, useLocation } from '@tanstack/react-router';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Filter,
  Inbox,
  Loader2,
  MessageSquare,
  Plus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { extractOAuthDomain } from '@/components/connectors/connector-display';
import type { ConnectorSelectorItem } from '@/components/connectors/connector-selector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useDebounce } from '@/hooks/use-debounce';
import { useScrollSentinel } from '@/hooks/use-scroll-sentinel';
import { useTabFilters } from '@/hooks/use-tab-filters';
import {
  useConnectorDefinitions,
  useEntityClassifiers,
  useInfiniteContentWithFilters,
  usePublicConnectorDefinitions,
  usePublicEntityClassifiers,
  usePublicInfiniteContentWithFilters,
} from '@/lib/api';
import { useAuthState } from '@/lib/auth-state';
import {
  applyEventTabDefaults,
  type ClassificationFilters,
  hasActiveFilters as checkActiveFilters,
  isDateFeedMode,
  type PartialEventFilters,
  parseEventFiltersFromUrl,
  serializeEventFiltersToSearch,
} from '@/lib/event-filters';
import { EntityLinkCell } from '../entity-link-cell';
import { TabErrorState } from '../tab-states';
import { EventCard } from './event-card';
import { EventsFilterBar } from './events-filter-bar';
import { EventsTimeline } from './events-timeline';
import { groupContentByThread, mergeEventTabFilters } from './navigation';

interface EventsTabProps {
  organizationId: string;
  ownerSlug?: string; // Required for org-wide mode drill-down links
  entityId?: number; // Optional - undefined means org-wide mode
  entityName?: string;
  entityBasePath?: string;
}

interface ClassifierEntry {
  slug: string;
  name: string;
  values: string[];
  parentSlug: string | null;
  valuesByParentValue: Record<string, string[]>;
}

interface WatcherClassifierGroup {
  watcherIds: number[];
  watcherName: string | null;
  classifiers: ClassifierEntry[];
}

// Thread grouping
const EVENT_FILTER_KEYS = [
  'platforms',
  'date_start',
  'date_end',
  'engagement_min',
  'engagement_max',
  'classifications',
  'q',
  'sort_by',
  'sort_order',
  'review_status',
  'window_id',
  'content_ids',
  'at',
];

export function EventsTab({
  organizationId,
  ownerSlug,
  entityId,
  entityName,
  entityBasePath,
}: EventsTabProps) {
  // Org-wide mode when entityId is undefined
  const isOrgWide = entityId === undefined;
  const { isAuthenticated } = useAuthState();
  const location = useLocation();

  const {
    filters: urlFilters,
    updateFilters: updateUrlFilters,
    clearFilters: clearUrlFilters,
  } = useTabFilters<PartialEventFilters>({
    parse: parseEventFiltersFromUrl,
    serialize: serializeEventFiltersToSearch,
    filterKeys: EVENT_FILTER_KEYS,
    merge: mergeEventTabFilters,
  });

  // Local search state (for debouncing)
  const [searchQuery, setSearchQuery] = useState(urlFilters.searchQuery || '');
  const debouncedSearch = useDebounce(searchQuery, 1000);

  // Combine URL filters with debounced search
  const filters = useMemo<PartialEventFilters>(
    () =>
      applyEventTabDefaults({
        ...urlFilters,
        searchQuery: debouncedSearch.length >= 3 ? debouncedSearch : undefined,
      }),
    [urlFilters, debouncedSearch]
  );

  const updateFilters = updateUrlFilters;

  useEffect(() => {
    const normalizedSearch = debouncedSearch.length >= 3 ? debouncedSearch : undefined;
    if ((urlFilters.searchQuery || undefined) === normalizedSearch) {
      return;
    }
    updateUrlFilters({ searchQuery: normalizedSearch });
  }, [debouncedSearch, updateUrlFilters, urlFilters.searchQuery]);

  const clearFilters = () => {
    setSearchQuery('');
    clearUrlFilters();
  };

  const hasFilters = checkActiveFilters(filters);

  // Fetch data
  const { data: connectorDefinitions = [] } = useConnectorDefinitions(
    isAuthenticated ? organizationId : null
  );
  const { data: publicConnectorDefinitions = [] } = usePublicConnectorDefinitions(
    !isAuthenticated ? ownerSlug : null
  );
  const effectiveConnectorDefinitions = isAuthenticated
    ? connectorDefinitions
    : publicConnectorDefinitions;

  // Classifiers only available when entity is specified
  const { data: classifiersData } = useEntityClassifiers(
    isAuthenticated ? organizationId : null,
    isOrgWide ? undefined : entityId
  );
  const { data: publicClassifiersData } = usePublicEntityClassifiers(
    !isAuthenticated && !isOrgWide ? ownerSlug : null,
    isOrgWide ? undefined : entityId
  );
  const effectiveClassifiersData = isAuthenticated ? classifiersData : publicClassifiersData;
  const classifierGroups = useMemo<WatcherClassifierGroup[]>(() => {
    const groupMap = new Map<string, WatcherClassifierGroup>();
    for (const c of effectiveClassifiersData || []) {
      const key = c.watcher_name ?? '__global__';
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          watcherIds: [],
          watcherName: c.watcher_name ?? null,
          classifiers: [],
        });
      }
      const group = groupMap.get(key)!;
      if (c.watcher_id != null && !group.watcherIds.includes(c.watcher_id)) {
        group.watcherIds.push(c.watcher_id);
      }

      const attrValues = c.attribute_values || {};
      const values = Object.keys(attrValues);

      // Detect parent-child from attribute_values.parent field
      let parentSlug: string | null = null;
      const valuesByParentValue: Record<string, string[]> = {};

      for (const [val, config] of Object.entries(attrValues)) {
        if (config.parent) {
          for (const [pSlug, pValue] of Object.entries(config.parent)) {
            parentSlug = pSlug;
            if (!valuesByParentValue[pValue]) {
              valuesByParentValue[pValue] = [];
            }
            valuesByParentValue[pValue].push(val);
          }
        }
      }

      const existing = group.classifiers.find((gc) => gc.slug === c.slug);
      if (existing) {
        const merged = new Set([...existing.values, ...values]);
        existing.values = [...merged];
        for (const [pVal, cVals] of Object.entries(valuesByParentValue)) {
          if (!existing.valuesByParentValue[pVal]) {
            existing.valuesByParentValue[pVal] = [];
          }
          const mergedVals = new Set([...existing.valuesByParentValue[pVal], ...cVals]);
          existing.valuesByParentValue[pVal] = [...mergedVals];
        }
        if (parentSlug) existing.parentSlug = parentSlug;
      } else {
        group.classifiers.push({
          slug: c.slug,
          name: c.name,
          values,
          parentSlug,
          valuesByParentValue,
        });
      }
    }

    // Sort: parents first, then children
    for (const group of groupMap.values()) {
      group.classifiers.sort((a, b) => {
        if (a.parentSlug === null && b.parentSlug !== null) return -1;
        if (a.parentSlug !== null && b.parentSlug === null) return 1;
        return 0;
      });
    }

    return [...groupMap.values()];
  }, [effectiveClassifiersData]);

  const connectors = useMemo<ConnectorSelectorItem[]>(() => {
    const definitionsByKey = new Map(
      effectiveConnectorDefinitions.map((definition) => [definition.key, definition])
    );
    const seenKeys = new Set<string>(definitionsByKey.keys());

    return [...seenKeys]
      .map((key) => {
        const definition = definitionsByKey.get(key);
        return {
          key,
          name: definition?.name || key,
          description: definition?.description,
          icon: definition?.icon,
          faviconDomain: extractOAuthDomain(definition?.auth_schema),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [effectiveConnectorDefinitions]);

  // Fetch events with infinite scroll
  const authInfiniteQuery = useInfiniteContentWithFilters(
    organizationId,
    entityId,
    filters,
    ownerSlug
  );
  const publicInfiniteQuery = usePublicInfiniteContentWithFilters(ownerSlug, entityId, filters);
  const infiniteQuery = isAuthenticated ? authInfiniteQuery : publicInfiniteQuery;
  const {
    data: infiniteData,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = infiniteQuery;

  const contents = useMemo(
    () => infiniteData?.pages.flatMap((p) => p.content) ?? [],
    [infiniteData]
  );
  const firstPage = infiniteData?.pages[0];
  const total = firstPage?.total ?? 0;
  const classificationStats = firstPage?.classification_stats;
  const hasCursorInUrl = !!(filters.beforeOccurredAt || filters.afterOccurredAt);
  const useDateFeed = isDateFeedMode(filters);

  // Update URL with scroll position when new pages are loaded (date feed mode)
  const lastPage = infiniteData?.pages[infiniteData.pages.length - 1];
  const lastLoadedItem = lastPage?.content[lastPage.content.length - 1];
  useEffect(() => {
    if (!useDateFeed || !lastLoadedItem || infiniteData?.pages.length === 1) return;
    updateUrlFilters({
      beforeOccurredAt: lastLoadedItem.occurred_at,
      beforeId: lastLoadedItem.id,
    });
  }, [
    lastLoadedItem?.id,
    useDateFeed,
    updateUrlFilters,
    infiniteData?.pages.length,
    lastLoadedItem,
  ]);

  const goToLatest = useCallback(() => {
    updateFilters({
      beforeOccurredAt: undefined,
      beforeId: undefined,
      afterOccurredAt: undefined,
      afterId: undefined,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [updateFilters]);

  // Infinite scroll sentinel
  const sentinelRef = useScrollSentinel({
    onIntersect: () => fetchNextPage(),
    enabled: !!hasNextPage && !isFetchingNextPage,
  });

  // Watcher group expand/collapse
  const [expandedWatchers, setExpandedWatchers] = useState<Set<string>>(new Set());
  const toggleWatcherGroup = (key: string) => {
    const newSet = new Set(expandedWatchers);
    if (newSet.has(key)) {
      newSet.delete(key);
    } else {
      newSet.add(key);
    }
    setExpandedWatchers(newSet);
  };

  // Thread grouping
  const threadGroups = useMemo(() => groupContentByThread(contents), [contents]);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [showDeepReplies, setShowDeepReplies] = useState<Set<string>>(new Set());

  const toggleThread = (rootId: string) => {
    const newSet = new Set(expandedThreads);
    if (newSet.has(rootId)) {
      newSet.delete(rootId);
    } else {
      newSet.add(rootId);
    }
    setExpandedThreads(newSet);
  };

  const toggleDeepReplies = (rootId: string) => {
    const newSet = new Set(showDeepReplies);
    if (newSet.has(rootId)) {
      newSet.delete(rootId);
    } else {
      newSet.add(rootId);
    }
    setShowDeepReplies(newSet);
  };

  // Handle date selection from timeline
  const handleTimelineSelect = (start: Date, end: Date) => {
    updateFilters({ dateRange: [start, end] });
  };

  // Classification filter toggle
  const handleClassificationToggle = (slug: string, value: string) => {
    const current = filters.classificationFilters || {};
    const values = current[slug] || [];
    const updated = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];

    const newFilters: ClassificationFilters = { ...current };
    if (updated.length > 0) {
      newFilters[slug] = updated;
    } else {
      delete newFilters[slug];
      // Clear child classifier filters when parent is fully deselected
      for (const group of classifierGroups) {
        for (const c of group.classifiers) {
          if (c.parentSlug === slug) {
            delete newFilters[c.slug];
          }
        }
      }
    }
    updateFilters({ classificationFilters: newFilters });
  };

  if (error) return <TabErrorState label="knowledge" />;

  const isInitialEmptyState = !isLoading && total === 0 && !hasFilters;

  if (isInitialEmptyState) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Inbox className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">
          No knowledge items{entityName ? ` for ${entityName}` : ''}
        </p>
        <p className="text-sm mt-1">
          {isAuthenticated
            ? 'Add a connector to start collecting knowledge here'
            : 'No public knowledge items are available yet'}
        </p>
        {isAuthenticated && (
          <Link
            to={
              (entityId
                ? location.pathname.replace(/\/events\/?$/, '/connectors')
                : `/${ownerSlug}/connectors`) as '/'
            }
          >
            <Button variant="outline" size="sm" className="mt-4">
              <Plus className="mr-2 h-4 w-4" />
              Add Connector
            </Button>
          </Link>
        )}
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Filter bar */}
        <EventsFilterBar
          filters={filters}
          onFiltersChange={updateFilters}
          onClearFilters={clearFilters}
          hasActiveFilters={hasFilters}
          connectors={connectors}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />

        {/* Content IDs filter banner (from permalink) */}
        {filters.contentIds != null && filters.contentIds.length > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              Showing knowledge item #{filters.contentIds.join(', #')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 ml-auto"
              onClick={() => updateFilters({ contentIds: undefined })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* Window filter banner */}
        {filters.windowId != null && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">
              Filtered by watcher window #{filters.windowId}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 ml-auto"
              onClick={() => updateFilters({ windowId: undefined })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* Timeline - only show when entity is specified */}
        {isAuthenticated && !isOrgWide && entityId && (
          <EventsTimeline
            entityId={entityId}
            organizationId={organizationId}
            ownerSlug={ownerSlug || ''}
            selectedRange={filters.dateRange || undefined}
            onSelectRange={handleTimelineSelect}
          />
        )}

        {/* Classification filter badges grouped by watcher */}
        {classifierGroups.length > 0 && (
          <div className="space-y-2">
            {classifierGroups.map((group) => {
              const groupKey = group.watcherName ?? '__global__';
              const hasActiveFilters = group.classifiers.some(
                (c) => (filters.classificationFilters?.[c.slug]?.length || 0) > 0
              );
              const isExpanded = expandedWatchers.has(groupKey) || hasActiveFilters;

              return (
                <Collapsible
                  key={groupKey}
                  open={isExpanded}
                  onOpenChange={() => toggleWatcherGroup(groupKey)}
                >
                  <div className="flex items-center gap-1.5">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    {group.watcherName &&
                      (group.watcherIds.length === 1 ? (
                        <Link
                          to={`${entityBasePath}/watchers/${group.watcherIds[0]}` as '/'}
                          className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {group.watcherName}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-muted-foreground">
                          {group.watcherName}
                        </span>
                      ))}
                  </div>
                  <CollapsibleContent className="space-y-1.5 mt-1.5 ml-6">
                    {group.classifiers
                      .filter((classifier) => classifier.parentSlug === null)
                      .map((classifier) => {
                        const selectedValues =
                          filters.classificationFilters?.[classifier.slug] || [];
                        const childClassifiers = group.classifiers.filter(
                          (c) => c.parentSlug === classifier.slug
                        );

                        return (
                          <div key={classifier.slug}>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium text-muted-foreground shrink-0">
                                {classifier.name}
                              </span>
                              {classifier.values.map((value) => {
                                const isSelected = selectedValues.includes(value);
                                const count = classificationStats?.[classifier.slug]?.[value];
                                return (
                                  <Badge
                                    key={value}
                                    variant={isSelected ? 'default' : 'outline'}
                                    className="cursor-pointer"
                                    onClick={() =>
                                      handleClassificationToggle(classifier.slug, value)
                                    }
                                  >
                                    {value}
                                    {count != null && (
                                      <span className="ml-1 opacity-60">{count}</span>
                                    )}
                                  </Badge>
                                );
                              })}
                            </div>
                            {selectedValues.length > 0 &&
                              childClassifiers.map((child) => {
                                const visibleValues = [
                                  ...new Set(
                                    selectedValues.flatMap(
                                      (pv) => child.valuesByParentValue[pv] || []
                                    )
                                  ),
                                ];
                                if (visibleValues.length === 0) return null;
                                return (
                                  <div
                                    key={child.slug}
                                    className="flex flex-wrap items-center gap-1.5 ml-4 mt-1.5"
                                  >
                                    <span className="text-sm font-medium text-muted-foreground shrink-0">
                                      {child.name}
                                    </span>
                                    {visibleValues.map((value) => {
                                      const isSelected =
                                        filters.classificationFilters?.[child.slug]?.includes(
                                          value
                                        );
                                      const count = classificationStats?.[child.slug]?.[value];
                                      return (
                                        <Badge
                                          key={value}
                                          variant={isSelected ? 'default' : 'outline'}
                                          className="cursor-pointer"
                                          onClick={() =>
                                            handleClassificationToggle(child.slug, value)
                                          }
                                        >
                                          {value}
                                          {count != null && (
                                            <span className="ml-1 opacity-60">{count}</span>
                                          )}
                                        </Badge>
                                      );
                                    })}
                                  </div>
                                );
                              })}
                          </div>
                        );
                      })}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        )}

        {/* Back to latest + content count */}
        {total > 0 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground pb-2">
            <span>{isLoading ? 'Loading...' : `${total.toLocaleString()} items`}</span>
            {hasCursorInUrl && (
              <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={goToLatest}>
                <ArrowUp className="h-3.5 w-3.5" />
                Back to latest
              </Button>
            )}
          </div>
        )}

        {/* Feed list */}
        {isLoading ? (
          <div className="space-y-4">
            {['skeleton-1', 'skeleton-2', 'skeleton-3'].map((key) => (
              <div key={key} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : contents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Inbox className="h-12 w-12 mb-4 opacity-50" />
            <p className="text-lg font-medium">No results found</p>
            <p className="text-sm mt-1">
              Try adjusting your filters to find what you are looking for
            </p>
            {hasFilters && (
              <Button variant="outline" size="sm" onClick={clearFilters} className="mt-4">
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from(threadGroups.entries()).map(([rootId, group]) => {
              const hasReplies = group.replies.length > 0;
              const isExpanded = expandedThreads.has(rootId);
              const showingDeep = showDeepReplies.has(rootId);

              // Separate shallow (depth <= 3) and deep (depth > 3) replies
              const shallowReplies = group.replies.filter((r) => r.depth <= 3);
              const deepReplies = group.replies.filter((r) => r.depth > 3);

              // If no root, this is an orphaned reply thread
              const isOrphanedThread = !group.root && group.replies.length > 0;
              const mainContent = group.root || group.replies[0];

              if (!mainContent) return null;

              return (
                <div key={rootId}>
                  {/* Entity link in org-wide mode */}
                  {isOrgWide && ownerSlug && mainContent.entity_name && (
                    <div className="mb-2">
                      <EntityLinkCell
                        ownerSlug={ownerSlug}
                        entity={{
                          entityId: mainContent.entity_ids?.[0],
                          entityName: mainContent.entity_name,
                          entityType: mainContent.entity_type || 'brand',
                          entitySlug: mainContent.entity_slug || '',
                        }}
                        tab="events"
                      />
                    </div>
                  )}

                  {/* Main event card */}
                  <EventCard
                    content={mainContent}
                    showParentContext={isOrphanedThread && !!mainContent.parent_context}
                  />

                  {/* Thread replies */}
                  {hasReplies && (
                    <Collapsible open={isExpanded}>
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 ml-6 gap-1"
                          onClick={() => toggleThread(rootId)}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          {isExpanded ? (
                            <>
                              <ChevronUp className="h-3.5 w-3.5" />
                              Hide {group.replies.length} replies
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3.5 w-3.5" />
                              Show {group.replies.length} replies
                            </>
                          )}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2 mt-2">
                        {/* Shallow replies */}
                        {shallowReplies.map((reply) => (
                          <EventCard key={reply.id} content={reply} isReply />
                        ))}

                        {/* Deep replies toggle */}
                        {deepReplies.length > 0 && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-12"
                              onClick={() => toggleDeepReplies(rootId)}
                            >
                              {showingDeep ? (
                                <>Hide {deepReplies.length} nested replies</>
                              ) : (
                                <>Show {deepReplies.length} nested replies</>
                              )}
                            </Button>
                            {showingDeep &&
                              deepReplies.map((reply) => (
                                <EventCard key={reply.id} content={reply} isReply />
                              ))}
                          </>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" />
        {isFetchingNextPage && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
