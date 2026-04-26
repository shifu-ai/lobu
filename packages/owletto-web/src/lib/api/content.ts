// Content types — canonical definition lives in @lobu/owletto-sdk
import type { ContentItem } from '@lobu/owletto-sdk';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getFilterIdentity } from '@/components/entity-tabs/events-tab/navigation';
import type { PartialEventFilters } from '../event-filters';
import { convertFiltersToApiParams, isDateFeedMode } from '../event-filters';
import {
  API_URL,
  apiCall,
  fetchWithTimeout,
  normalizeOrgContext,
  resolveApiScope,
  resolveOrgSelector,
} from './core';
import { createOrgQuery, createQuery } from './hook-factory';

export type { ContentItem };

// ExtendedContentItem is a legacy alias — ContentItem from the SDK includes all fields.
export type ExtendedContentItem = ContentItem;

export interface ExtendedContentListResult {
  content: ExtendedContentItem[];
  total: number;
  classification_stats?: Record<string, Record<string, number>>;
  timeline?: Array<{ date: string; count: number }>;
  page: {
    limit: number;
    offset: number;
    has_more: boolean;
    has_older?: boolean;
    has_newer?: boolean;
  };
}

// Extended content fetch with filters
// entityId is optional - when undefined, fetches content across all entities (org-wide mode)
export const useContentWithFilters = createOrgQuery<
  [
    organizationId?: string | null,
    entityId?: number,
    filters?: PartialEventFilters,
    orgSlug?: string,
  ],
  ExtendedContentListResult
>({
  queryKey: (ctx, _organizationId, entityId, filters) => {
    const params = filters ? convertFiltersToApiParams(filters, entityId) : null;
    return ['contents-filtered', ctx.organizationId, ctx.slug, entityId, params];
  },
  tool: 'read_knowledge',
  body: (_organizationId, entityId, filters) => {
    const params = filters ? convertFiltersToApiParams(filters, entityId) : {};
    return { ...params, include_classification: 'summary' };
  },
  orgContext: (_organizationId, _entityId, _filters, orgSlug) =>
    orgSlug ? { slug: orgSlug } : undefined,
  enabled: (ctx, organizationId, _entityId, filters) =>
    !!organizationId && !!filters && !!(ctx.organizationId || ctx.slug),
  staleTime: 30000,
});

function appendQueryParam(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    params.set(key, value.join(','));
    return;
  }
  if (typeof value === 'object') {
    params.set(key, JSON.stringify(value));
    return;
  }
  params.set(key, String(value));
}

export function usePublicContentWithFilters(
  orgSlug?: string | null,
  entityId?: number,
  filters?: PartialEventFilters
) {
  return useQuery({
    queryKey: ['public-contents-filtered', orgSlug, entityId, filters],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const apiParams = convertFiltersToApiParams(filters ?? {}, entityId);
      const searchParams = new URLSearchParams();

      for (const [key, value] of Object.entries(apiParams)) {
        appendQueryParam(searchParams, key, value);
      }

      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/knowledge/search?${searchParams.toString()}`,
        {
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return (await response.json()) as ExtendedContentListResult;
    },
    enabled: !!orgSlug && !!filters,
    staleTime: 30000,
  });
}

// ============================================================
// Infinite scroll content queries
// ============================================================

const PAGE_SIZE = 50;

type InfinitePageParam = null | {
  before_occurred_at?: string;
  before_id?: number;
  offset?: number;
};

function getNextPageParam(
  lastPage: ExtendedContentListResult,
  isDateFeed: boolean
): InfinitePageParam | undefined {
  if (isDateFeed) {
    if (!lastPage.page.has_older) return undefined;
    const lastItem = lastPage.content[lastPage.content.length - 1];
    if (!lastItem?.occurred_at) return undefined;
    return { before_occurred_at: lastItem.occurred_at, before_id: lastItem.id };
  }
  if (!lastPage.page.has_more) return undefined;
  return { offset: lastPage.page.offset + lastPage.page.limit };
}

function buildInfiniteApiParams(
  baseFilters: PartialEventFilters,
  entityId: number | undefined,
  pageParam: InfinitePageParam
): Record<string, unknown> {
  const filtersForApi: PartialEventFilters = { ...baseFilters };
  // Strip any cursor/page from base filters — we use pageParam instead
  delete filtersForApi.page;
  delete filtersForApi.beforeOccurredAt;
  delete filtersForApi.beforeId;
  delete filtersForApi.afterOccurredAt;
  delete filtersForApi.afterId;

  if (pageParam) {
    if (pageParam.before_occurred_at != null && pageParam.before_id != null) {
      filtersForApi.beforeOccurredAt = pageParam.before_occurred_at;
      filtersForApi.beforeId = pageParam.before_id;
    }
  }

  const offset = pageParam?.offset;
  return convertFiltersToApiParams(filtersForApi, entityId, {
    limit: PAGE_SIZE,
    ...(offset != null ? { offset } : {}),
  });
}

export function useInfiniteContentWithFilters(
  organizationId?: string | null,
  entityId?: number,
  filters?: PartialEventFilters,
  orgSlug?: string
) {
  const ctx = normalizeOrgContext(orgSlug ? { slug: orgSlug } : undefined);
  const hasContext = !!(ctx.organizationId || ctx.slug);
  const isDateFeed = filters ? isDateFeedMode(filters) : false;
  const filterIdentity = filters ? getFilterIdentity(filters) : null;

  return useInfiniteQuery({
    queryKey: ['contents-infinite', ctx.organizationId, ctx.slug, entityId, filterIdentity],
    queryFn: async ({ pageParam }) => {
      const params = buildInfiniteApiParams(filters ?? {}, entityId, pageParam);
      return apiCall<ExtendedContentListResult>(
        'read_knowledge',
        { ...params, include_classification: 'summary' },
        resolveOrgSelector(ctx)
      );
    },
    initialPageParam: null as InfinitePageParam,
    getNextPageParam: (lastPage) => getNextPageParam(lastPage, isDateFeed),
    enabled: !!organizationId && !!filters && hasContext,
    staleTime: 30000,
  });
}

export function usePublicInfiniteContentWithFilters(
  orgSlug?: string | null,
  entityId?: number,
  filters?: PartialEventFilters
) {
  const isDateFeed = filters ? isDateFeedMode(filters) : false;
  const filterIdentity = filters ? getFilterIdentity(filters) : null;

  return useInfiniteQuery({
    queryKey: ['public-contents-infinite', orgSlug, entityId, filterIdentity],
    queryFn: async ({ pageParam }) => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const params = buildInfiniteApiParams(filters ?? {}, entityId, pageParam);
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        appendQueryParam(searchParams, key, value);
      }

      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/knowledge/search?${searchParams.toString()}`,
        { credentials: 'include' }
      );
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      return (await response.json()) as ExtendedContentListResult;
    },
    initialPageParam: null as InfinitePageParam,
    getNextPageParam: (lastPage) => getNextPageParam(lastPage, isDateFeed),
    enabled: !!orgSlug && !!filters,
    staleTime: 30000,
  });
}

export const useEventsByConnectionIds = createOrgQuery<
  [connectionIds: number[], orgSlug?: string],
  ExtendedContentListResult
>({
  queryKey: (ctx, connectionIds) => [
    'events-by-connections',
    connectionIds,
    ctx.organizationId,
    ctx.slug,
  ],
  tool: 'read_knowledge',
  body: (connectionIds) => ({
    connection_ids: connectionIds,
    limit: 30,
    sort_by: 'date',
    sort_order: 'desc',
  }),
  orgContext: (_connectionIds, orgSlug) => (orgSlug ? { slug: orgSlug } : undefined),
  enabled: (_ctx, connectionIds) => connectionIds.length > 0,
  staleTime: 30000,
});

// ============================================================
// Content Distribution (Timeline)
// ============================================================

export interface ContentDistributionResult {
  distribution: Array<{ date: string; count: number; platform?: string }>;
}

export function useContentDistribution(
  organizationId?: string | null,
  options?: {
    entityId?: number;
    connectionIds?: number[];
    groupByPlatform?: boolean;
  },
  orgContext?: string | { slug?: string | null }
) {
  return useQuery({
    queryKey: [
      'content-distribution',
      organizationId,
      options?.entityId,
      options?.connectionIds,
      options?.groupByPlatform,
      typeof orgContext === 'string' ? orgContext : orgContext?.slug,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.connectionIds && options.connectionIds.length > 0) {
        params.append('connection_ids', options.connectionIds.join(','));
      }
      if (options?.groupByPlatform) {
        params.append('group_by_platform', 'true');
      }
      const queryString = params.toString();
      const scope = resolveApiScope(orgContext);
      const url = `${API_URL}/api/${scope.slug}/entities/${options?.entityId}/content-distribution${queryString ? `?${queryString}` : ''}`;

      const response = await fetchWithTimeout(url, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result: ContentDistributionResult = await response.json();
      return result.distribution || [];
    },
    enabled: !!organizationId && !!options?.entityId,
    staleTime: 60000,
  });
}

// ============================================================
// Classifiers
// ============================================================

export interface ClassifierValue {
  value: string;
  description?: string;
  examples?: string[];
}

export interface Classifier {
  id: number;
  slug: string;
  name: string;
  description?: string;
  attribute_key: string;
  current_version: number;
  min_similarity: number;
  fallback_value?: string;
  attribute_values: Record<
    string,
    { description?: string; examples?: string[]; parent?: Record<string, string> }
  >;
  is_inherited?: boolean;
  watcher_id?: number | null;
  watcher_name?: string | null;
}

export interface ClassifiersResult {
  classifiers: Classifier[];
}

export const useEntityClassifiers = createQuery<
  [organizationId?: string | null, entityId?: number],
  Classifier[]
>({
  queryKey: (organizationId, entityId) => ['classifiers', organizationId, entityId],
  tool: 'manage_classifiers',
  body: (_organizationId, entityId) => ({
    action: 'list',
    entity_id: entityId,
  }),
  transform: (r) => r.data?.classifiers || [],
  enabled: (organizationId, entityId) => !!organizationId && !!entityId,
  staleTime: 60000,
});

export function usePublicEntityClassifiers(orgSlug?: string | null, entityId?: number) {
  return useQuery({
    queryKey: ['public-classifiers', orgSlug, entityId],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const params = new URLSearchParams();
      if (entityId) params.set('entity_id', String(entityId));

      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/classifiers${params.toString() ? `?${params}` : ''}`,
        {
          credentials: 'include',
        }
      );
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const result = (await response.json()) as ClassifiersResult & {
        data?: { classifiers?: Classifier[] };
      };
      return result.data?.classifiers ?? [];
    },
    enabled: !!orgSlug && !!entityId,
    staleTime: 60000,
  });
}
