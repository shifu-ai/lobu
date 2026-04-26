import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

type SearchParams = URLSearchParams | Record<string, string | undefined>;

interface UseTabFiltersOptions<TFilters> {
  /** Parse URL search params into typed filters */
  parse: (params: SearchParams) => TFilters;
  /** Serialize typed filters into URL search params */
  serialize: (filters: TFilters) => Record<string, string | undefined>;
  /** Keys to clear when updating filters (filter-specific params) */
  filterKeys: string[];
  /** Whether to also clear clf_* params (default: true) */
  clearClassifications?: boolean;
  /** Merge function: how to combine current filters with updates (default: shallow merge) */
  merge?: (current: TFilters, updates: Partial<TFilters>) => TFilters;
}

/**
 * URL-based filter state management for tab components.
 * Handles parsing from URL, merging updates, serializing back, and navigating.
 */
export function useTabFilters<TFilters>(options: UseTabFiltersOptions<TFilters>) {
  const { parse, serialize, filterKeys, clearClassifications = true, merge } = options;
  const navigate = useNavigate();
  const location = useLocation();

  const filters = useMemo(() => {
    const searchEntries = Object.entries(location.search || {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null
    );
    const searchParams = new URLSearchParams(searchEntries);
    return parse(searchParams);
  }, [location.search, parse]);

  const updateFilters = useCallback(
    (updates: Partial<TFilters>) => {
      const newFilters = merge ? merge(filters, updates) : ({ ...filters, ...updates } as TFilters);

      const filterParams = serialize(newFilters);

      // Preserve existing non-filter params
      const newSearch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(location.search || {})) {
        if (value !== undefined && value !== null) {
          newSearch[key] = value;
        }
      }

      // Clear existing filter params
      for (const key of filterKeys) {
        delete newSearch[key];
      }

      // Clear clf_* params
      if (clearClassifications) {
        for (const key of Object.keys(newSearch)) {
          if (key.startsWith('clf_')) {
            delete newSearch[key];
          }
        }
      }

      // Add new filter params
      for (const [key, value] of Object.entries(filterParams)) {
        if (value !== undefined) {
          newSearch[key] = value;
        }
      }

      navigate({
        to: location.pathname as '/',
        search: newSearch,
        replace: true,
      });
    },
    [filters, serialize, filterKeys, clearClassifications, merge, navigate, location]
  );

  const clearFilters = useCallback(() => {
    navigate({
      to: location.pathname as '/',
      search: {},
      replace: true,
    });
  }, [navigate, location.pathname]);

  return { filters, updateFilters, clearFilters };
}
