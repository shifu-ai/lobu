/**
 * React Query hooks for watchers API
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { apiCall, type Watcher } from '@/lib/api';
import { API_URL, fetchWithTimeout, resolveApiScope } from '@/lib/api/core';
import { findWatcherGroup } from '@/lib/watcher-groups';
import type { WatcherTimeGranularity } from '@/lib/watcher-time';

// ============================================================
// Types
// ============================================================

export type TimeGranularity = WatcherTimeGranularity | 'auto';

export interface WatcherWindow {
  window_id: number;
  window_start: string;
  window_end: string;
  granularity: TimeGranularity;
  extracted_data: Record<string, unknown>;
  previous_extracted_data?: Record<string, unknown>;
  content_analyzed: number;
  model_used?: string;
  client_id?: string;
  run_metadata?: Record<string, unknown>;
  execution_time_ms: number;
  is_rollup: boolean;
  created_at: string;
  classification_stats?: Record<string, Record<string, number>>;
  version_id?: number;
  json_template?: unknown;
  watcher_id?: string;
  entity_id?: number;
  entity_name?: string;
  entity_type?: string;
  entity_slug?: string;
}

export interface WatcherVersionInfo {
  version: number;
  name: string;
  created_at: string;
  is_current: boolean;
}

export interface WatcherMetadata {
  watcher_id: string;
  watcher_name: string;
  slug: string;
  status: 'active' | 'archived';
  version: number;
  schedule?: string | null;
  next_run_at?: string | null;
  agent_id?: string | null;
  scheduler_client_id?: string | null;
  sources: Array<{ name: string; query: string }>;
  prompt?: string;
  description?: string;
  extraction_schema?: Record<string, unknown>;
  json_template?: unknown;
  rendered_prompt?: string;
  available_versions?: WatcherVersionInfo[];
  reaction_script?: string;
  watcher_run?: {
    run_id: number;
    status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
    error_message?: string | null;
    created_at?: string | null;
    completed_at?: string | null;
  };
}

export interface ClassificationTimelineSeries {
  classifier_slug: string;
  classifier_name: string;
  timestamp: string;
  date: string;
  count: number;
}

export interface ClassificationTimeline {
  series: ClassificationTimelineSeries[];
  totals?: Record<string, Record<string, number>>;
}

export interface UnprocessedRange {
  month: string;
  window_start: string;
  window_end: string;
  total_content: number;
  processed_content: number;
  unprocessed_content: number;
  status: 'unprocessed' | 'partial' | 'complete';
}

export interface PendingAnalysis {
  unprocessed_count: number;
  next_window?: {
    start: string;
    end: string;
  };
  unprocessed_ranges?: UnprocessedRange[];
}

export interface EntityContext {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  total_content: number;
  active_connections: number;
  latest_content_date: string | null;
}

export interface WatcherDetailResult {
  windows: WatcherWindow[];
  watcher: WatcherMetadata;
  pending_analysis?: PendingAnalysis;
  entity_context?: EntityContext;
  classification_timeline?: ClassificationTimeline;
  warnings?: string[];
}

export interface WatcherGroupDetailResult {
  group: {
    group_id: string;
    name: string;
    description?: string;
    schedule?: string | null;
    assignments_count: number;
    active_assignments_count: number;
    archived_assignments_count: number;
    total_windows_count: number;
  };
  assignments: Watcher[];
  windows: WatcherWindow[];
  json_template?: unknown;
}

export interface WindowContentItem {
  id: number;
  platform: string;
  author_name: string | null;
  title: string | null;
  text_content: string;
  source_url: string | null;
  score: number;
  normalized_score: number;
  classifications: Record<string, unknown>;
  occurred_at: string;
}

export interface WindowContentResult {
  content: WindowContentItem[];
  total: number;
}

export interface WatcherReferenceItem {
  id: number;
  title: string | null;
  source_url: string | null;
  author_name: string | null;
  platform: string;
}

// ============================================================
// Hooks
// ============================================================

/**
 * Fetch list of watchers for an entity
 * entityId is optional - when undefined, fetches watchers across all entities (org-wide mode)
 */
export function useWatchersList(
  organizationId: string | undefined,
  entityId?: number,
  options?: { includeDetails?: boolean }
) {
  return useQuery({
    queryKey: ['watchers-list', organizationId, entityId, options?.includeDetails ?? true],
    queryFn: async () => {
      const result = await apiCall<{ watchers: Watcher[] }>('list_watchers', {
        entity_id: entityId, // undefined = all entities
        status: 'active',
        include_details: options?.includeDetails ?? true,
      });
      return result.watchers || [];
    },
    // Only requires organizationId - entityId is optional
    enabled: !!organizationId,
    staleTime: 30000,
  });
}

export function usePublicWatchersList(
  orgSlug: string | undefined,
  entityId?: number,
  options?: { includeDetails?: boolean }
) {
  return useQuery({
    queryKey: ['public-watchers-list', orgSlug, entityId, options?.includeDetails ?? false],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const params = new URLSearchParams();
      if (entityId) params.set('entity_id', String(entityId));
      if (options?.includeDetails) params.set('include_details', 'true');

      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/watchers${params.toString() ? `?${params}` : ''}`,
        {
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = (await response.json()) as { watchers?: Watcher[] };
      return result.watchers ?? [];
    },
    enabled: !!orgSlug,
    staleTime: 30000,
  });
}

/**
 * Fetch watcher detail with windows
 */
export function useWatcherDetail(
  watcherId: string | undefined,
  entityId: number | undefined,
  organizationId: string | undefined,
  options: {
    since?: string;
    until?: string;
    granularity?: TimeGranularity;
    templateVersion?: number;
  } = {}
) {
  return useQuery({
    queryKey: [
      'watcher-detail',
      watcherId,
      entityId,
      options.since,
      options.until,
      options.granularity,
      options.templateVersion,
    ],
    queryFn: async () => {
      const result = await apiCall<WatcherDetailResult>('get_watcher', {
        watcher_id: watcherId,
        entity_id: entityId,
        content_since: options.since,
        content_until: options.until,
        granularity: options.granularity,
        template_version: options.templateVersion,
        page_size: 100,
        include_classification: 'summary,timeline',
      });
      return result;
    },
    enabled: !!watcherId && !!organizationId,
    staleTime: 30000,
  });
}

export function usePublicWatcherDetail(
  orgSlug: string | undefined,
  watcherId: string | undefined,
  entityId: number | undefined,
  options: {
    since?: string;
    until?: string;
    granularity?: TimeGranularity;
    templateVersion?: number;
  } = {}
) {
  return useQuery({
    queryKey: [
      'public-watcher-detail',
      orgSlug,
      watcherId,
      entityId,
      options.since,
      options.until,
      options.granularity,
      options.templateVersion,
    ],
    queryFn: async () => {
      const scope = resolveApiScope({ slug: orgSlug ?? null });
      const params = new URLSearchParams();
      if (watcherId) params.set('watcher_id', watcherId);
      if (entityId) params.set('entity_id', String(entityId));
      if (options.since) params.set('content_since', options.since);
      if (options.until) params.set('content_until', options.until);
      if (options.granularity) params.set('granularity', options.granularity);
      if (options.templateVersion) params.set('template_version', String(options.templateVersion));
      params.set('page_size', '100');
      params.set('include_classification', 'summary,timeline');

      const response = await fetchWithTimeout(
        `${API_URL}/api/${scope.slug}/public/watchers?${params.toString()}`,
        {
          credentials: 'include',
        }
      );

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      return (await response.json()) as WatcherDetailResult;
    },
    enabled: !!orgSlug && !!watcherId,
    staleTime: 30000,
  });
}

export function useWatcherGroupDetail({
  groupId,
  organizationId,
  ownerSlug,
  isAuthenticated,
  filters = {},
}: {
  groupId: string | undefined;
  organizationId?: string;
  ownerSlug?: string;
  isAuthenticated: boolean;
  filters?: {
    since?: string;
    until?: string;
    granularity?: TimeGranularity;
    templateVersion?: number;
    entityIds?: number[];
  };
}) {
  const authListQuery = useWatchersList(isAuthenticated ? organizationId : undefined, undefined, {
    includeDetails: true,
  });
  const publicListQuery = usePublicWatchersList(
    !isAuthenticated ? ownerSlug : undefined,
    undefined,
    {
      includeDetails: false,
    }
  );

  const assignments = (isAuthenticated ? authListQuery.data : publicListQuery.data) ?? [];
  const group = useMemo(() => findWatcherGroup(assignments, groupId), [assignments, groupId]);

  const selectedEntityIds = useMemo(
    () =>
      new Set(
        (filters.entityIds ?? [])
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.trunc(value))
      ),
    [filters.entityIds]
  );

  const visibleAssignments = useMemo(() => {
    if (!group) return [];
    if (selectedEntityIds.size === 0) return group.assignments;
    return group.assignments.filter((assignment) => selectedEntityIds.has(assignment.entity_id));
  }, [group, selectedEntityIds]);

  const detailQueries = useQueries({
    queries: visibleAssignments.map((assignment) => ({
      queryKey: [
        isAuthenticated ? 'watcher-group-detail' : 'public-watcher-group-detail',
        group?.groupId,
        assignment.watcher_id,
        assignment.entity_id,
        filters.since,
        filters.until,
        filters.granularity,
        filters.templateVersion,
      ],
      queryFn: async () => {
        if (isAuthenticated) {
          return apiCall<WatcherDetailResult>('get_watcher', {
            watcher_id: assignment.watcher_id,
            entity_id: assignment.entity_id,
            content_since: filters.since,
            content_until: filters.until,
            granularity: filters.granularity,
            template_version: filters.templateVersion,
            page_size: 100,
            include_classification: 'summary,timeline',
          });
        }

        const scope = resolveApiScope({ slug: ownerSlug ?? null });
        const params = new URLSearchParams();
        params.set('watcher_id', assignment.watcher_id);
        params.set('entity_id', String(assignment.entity_id));
        if (filters.since) params.set('content_since', filters.since);
        if (filters.until) params.set('content_until', filters.until);
        if (filters.granularity) params.set('granularity', filters.granularity);
        if (filters.templateVersion) {
          params.set('template_version', String(filters.templateVersion));
        }
        params.set('page_size', '100');
        params.set('include_classification', 'summary,timeline');

        const response = await fetchWithTimeout(
          `${API_URL}/api/${scope.slug}/public/watchers?${params.toString()}`,
          {
            credentials: 'include',
          }
        );

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        return (await response.json()) as WatcherDetailResult;
      },
      enabled:
        !!group?.groupId &&
        (!!assignment.watcher_id || !!assignment.entity_id) &&
        (isAuthenticated ? !!organizationId : !!ownerSlug),
      staleTime: 30000,
    })),
  });

  const mergedWindows = useMemo(() => {
    return visibleAssignments
      .flatMap((assignment, index) => {
        const detail = detailQueries[index]?.data;
        const watcherJsonTemplate = detail?.watcher?.json_template;
        return (detail?.windows ?? []).map((window) => ({
          ...window,
          watcher_id: assignment.watcher_id,
          entity_id: assignment.entity_id,
          entity_name: assignment.entity_name,
          entity_type: assignment.entity_type,
          entity_slug: assignment.entity_slug,
          json_template: window.json_template ?? watcherJsonTemplate,
        }));
      })
      .sort((a, b) => new Date(b.window_start).getTime() - new Date(a.window_start).getTime());
  }, [visibleAssignments, detailQueries]);

  const groupResult = useMemo<WatcherGroupDetailResult | undefined>(() => {
    if (!group) return undefined;

    const firstDetail = detailQueries.find((query) => query.data?.watcher)?.data;

    return {
      group: {
        group_id: group.groupId,
        name: group.name,
        description: firstDetail?.watcher?.description ?? group.description,
        schedule: firstDetail?.watcher?.schedule ?? group.schedule,
        assignments_count: group.assignmentsCount,
        active_assignments_count: group.activeAssignmentsCount,
        archived_assignments_count: group.archivedAssignmentsCount,
        total_windows_count: mergedWindows.length,
      },
      assignments: visibleAssignments,
      windows: mergedWindows,
      json_template: firstDetail?.watcher?.json_template,
    };
  }, [group, detailQueries, mergedWindows, visibleAssignments]);

  const isAssignmentsLoading = authListQuery.isLoading || publicListQuery.isLoading;
  const isContentLoading = detailQueries.some((query) => query.isLoading);
  const isInitialLoading = isAssignmentsLoading && !group;

  return {
    data: groupResult,
    availableAssignments: group?.assignments ?? [],
    isLoading: isInitialLoading,
    isInitialLoading,
    isContentLoading,
    error:
      authListQuery.error ??
      publicListQuery.error ??
      detailQueries.find((query) => query.error)?.error ??
      null,
  };
}

/**
 * Fetch content references by explicit content IDs
 */
export function useWatcherEventReferences(
  entityId: number | undefined,
  contentIds: number[],
  organizationId?: string,
  orgSlug?: string
) {
  const uniqueSortedIds = Array.from(
    new Set(
      contentIds
        .filter((id) => Number.isFinite(id))
        .map((id) => Math.trunc(id))
        .filter((id) => id > 0)
    )
  ).sort((a, b) => a - b);

  return useQuery({
    queryKey: [
      'watcher-event-references',
      organizationId,
      orgSlug,
      entityId,
      uniqueSortedIds.join(','),
    ],
    queryFn: async () => {
      let result: WindowContentResult;
      if (organizationId) {
        result = await apiCall<WindowContentResult>('read_knowledge', {
          entity_id: entityId,
          content_ids: uniqueSortedIds,
          limit: Math.max(uniqueSortedIds.length, 50),
          offset: 0,
          sort_by: 'date',
          sort_order: 'desc',
        });
      } else {
        const scope = resolveApiScope({ slug: orgSlug ?? null });
        const params = new URLSearchParams({
          query: 'references',
          limit: String(Math.max(uniqueSortedIds.length, 50)),
          offset: '0',
          sort_by: 'date',
          sort_order: 'desc',
          content_ids: uniqueSortedIds.join(','),
        });
        if (entityId) params.set('entity_id', String(entityId));

        const response = await fetchWithTimeout(
          `${API_URL}/api/${scope.slug}/public/knowledge/search?${params.toString()}`,
          {
            credentials: 'include',
          }
        );
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }
        result = (await response.json()) as WindowContentResult;
      }

      return (result.content || []).map((item) => ({
        id: item.id,
        title: item.title,
        source_url: item.source_url,
        author_name: item.author_name,
        platform: item.platform,
      })) as WatcherReferenceItem[];
    },
    enabled: (!!organizationId || !!orgSlug) && !!entityId && uniqueSortedIds.length > 0,
    staleTime: 30000,
  });
}

/**
 * Update a watcher's settings
 */
export function useUpdateWatcher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      watcher_id: string;
      schedule?: string | null;
      agent_id?: string | null;
      scheduler_client_id?: string | null;
      model_config?: Record<string, unknown>;
      tags?: string[];
    }) => {
      return apiCall('manage_watchers', { action: 'update', ...params });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
      toast.success('Watcher updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update watcher');
    },
  });
}

/**
 * Delete an watcher
 */
export function useDeleteWatcher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (watcherId: string) => {
      return apiCall('manage_watchers', {
        action: 'delete',
        watcher_ids: [watcherId],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
      toast.success('Watcher deleted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to delete watcher');
    },
  });
}

export function useTriggerWatcher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (watcherId: string) => {
      return apiCall<{ watcher_id: string; run_id: number; status: string }>('manage_watchers', {
        action: 'trigger',
        watcher_id: watcherId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
      toast.success('Watcher run queued');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to trigger watcher');
    },
  });
}

/**
 * Create a new watcher with prompt/schema/sources
 */
export function useCreateWatcher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      slug: string;
      name: string;
      description?: string;
      prompt: string;
      extraction_schema: Record<string, unknown>;
      json_template?: unknown;
      entity_id?: number;
      schedule?: string;
      sources?: Array<{ name: string; query: string }>;
      agent_id?: string;
      scheduler_client_id?: string;
      classifiers?: unknown[];
      keying_config?: Record<string, unknown>;
      condensation_prompt?: string;
      condensation_window_count?: number;
      reactions_guidance?: string;
      model_config?: Record<string, unknown>;
      tags?: string[];
    }) => {
      return apiCall<{ watcher_id: string }>('manage_watchers', {
        action: 'create',
        ...params,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
      toast.success('Watcher created');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create watcher');
    },
  });
}

/**
 * Create a new version of a watcher
 */
export function useCreateWatcherVersion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      watcher_id: string;
      name?: string;
      description?: string;
      prompt?: string;
      extraction_schema?: Record<string, unknown>;
      json_template?: unknown;
      sources?: Array<{ name: string; query: string }>;
      set_as_current?: boolean;
      change_notes?: string;
      // Watcher-level fields (applied atomically with the version)
      scheduler_client_id?: string | null;
      schedule?: string | null;
      classifiers?: unknown[];
      keying_config?: Record<string, unknown>;
      condensation_prompt?: string;
      condensation_window_count?: number;
      reactions_guidance?: string;
    }) => {
      return apiCall<{
        watcher_id: string;
        version: number;
        version_id: string;
        previous_version: number;
      }>('manage_watchers', {
        action: 'create_version',
        ...params,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
    },
  });
}

/**
 * Set or remove a reaction script for a watcher
 */
export function useSetReactionScript() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { watcher_id: string; reaction_script: string }) => {
      return apiCall<{
        watcher_id: string;
        has_script: boolean;
        message: string;
      }>('manage_watchers', {
        action: 'set_reaction_script',
        ...params,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
    },
  });
}

/**
 * Upgrade a watcher to a specific version
 */
export function useUpgradeWatcher() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { watcher_id: string; target_version: number }) => {
      return apiCall<{
        watcher_id: string;
        version: number;
        previous_version: number;
      }>('manage_watchers', {
        action: 'upgrade',
        ...params,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watchers-list'] });
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({ queryKey: ['watchers'] });
    },
  });
}

/**
 * Delete a specific window
 */
export function useDeleteWindow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (windowId: number) => {
      return apiCall('manage_queue', {
        action: 'delete_window',
        window_id: windowId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
    },
  });
}

/**
 * Per-field correction sent to submit_feedback. The backend stores one row
 * per entry so future submissions supersede earlier ones for the same
 * field_path.
 */
export interface CorrectionInput {
  field_path: string;
  mutation?: 'set' | 'remove' | 'add';
  value?: unknown;
  note?: string;
}

export interface FeedbackEntry {
  id: number;
  window_id: number;
  field_path: string;
  mutation: 'set' | 'remove' | 'add';
  corrected_value: unknown;
  note: string | null;
  created_by: string;
  created_at: string;
  window_start?: string;
  window_end?: string;
}

/**
 * Submit field corrections for a watcher window's extracted data.
 */
export function useSubmitFeedback() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      watcher_id: string;
      window_id: number;
      corrections: CorrectionInput[];
    }) => {
      return apiCall<{ feedback_ids: number[] }>('manage_watchers', {
        action: 'submit_feedback',
        ...params,
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['watcher-detail'] });
      queryClient.invalidateQueries({
        queryKey: ['watcher-feedback', variables.watcher_id],
      });
      toast.success('Corrections submitted');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to submit corrections');
    },
  });
}

/**
 * Fetch existing corrections for a watcher (optionally scoped to a window).
 * Returned entries are ordered most-recent first.
 */
export function useGetFeedback(
  watcherId: string | undefined,
  windowId?: number,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: ['watcher-feedback', watcherId, windowId ?? 'all'],
    enabled: !!watcherId && (options.enabled ?? true),
    queryFn: async () => {
      const result = await apiCall<{ feedback: FeedbackEntry[] }>('manage_watchers', {
        action: 'get_feedback',
        watcher_id: watcherId,
        ...(windowId !== undefined ? { window_id: windowId } : {}),
      });
      return result.feedback;
    },
  });
}
