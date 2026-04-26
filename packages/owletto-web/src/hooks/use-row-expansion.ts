import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Manages expandable row state for table components.
 * Used by ConnectionsTab and similar table views.
 */
export function useRowExpansion(initialIds?: number[]) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const prevKey = useRef('');

  useEffect(() => {
    const key = initialIds?.join(',') ?? '';
    if (key && key !== prevKey.current) {
      prevKey.current = key;
      setExpandedRows(new Set(initialIds));
    }
  }, [initialIds]);

  const toggleRow = useCallback((id: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const isExpanded = useCallback((id: number) => expandedRows.has(id), [expandedRows]);

  return { expandedRows, toggleRow, isExpanded };
}
