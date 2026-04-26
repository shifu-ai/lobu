import { buildEntityUrl, type EntityPathSegment } from '@/lib/url';

/**
 * Entity reference for drill-down navigation in org-wide mode
 */
export interface EntityReference {
  entityId: number;
  entityName: string;
  entityType: string;
  entitySlug: string;
  parentEntityType?: string | null;
  parentEntitySlug?: string | null;
}

/**
 * Tab names for navigation
 */
export type EntityTabName = 'overview' | 'connectors' | 'events' | 'watchers';

export function getEntityTabPathSegment(tab: EntityTabName): string {
  switch (tab) {
    case 'connectors':
      return 'connectors';
    case 'events':
      return 'events';
    case 'watchers':
      return 'watchers';
    case 'overview':
    default:
      return '';
  }
}

export function parseEntityTabSegment(segment?: string | null): EntityTabName | undefined {
  switch (segment) {
    case 'connectors':
    case 'connections':
    case 'connector':
      return 'connectors';
    case 'events':
      return 'events';
    case 'watchers':
      return 'watchers';
    default:
      return undefined;
  }
}

/**
 * Build URL for drill-down navigation to an entity's specific tab
 * Uses path-based tabs: /namespace/type/slug/tab
 */
export function buildEntityTabUrl(
  ownerSlug: string,
  entity: EntityReference,
  tab: EntityTabName
): string {
  const segments: EntityPathSegment[] = [];
  if (entity.parentEntityType && entity.parentEntitySlug) {
    segments.push({
      entity_type: entity.parentEntityType,
      slug: entity.parentEntitySlug,
    });
  }
  segments.push({ entity_type: entity.entityType, slug: entity.entitySlug });
  const baseUrl = buildEntityUrl(ownerSlug, segments);
  const tabPath = getEntityTabPathSegment(tab);
  return tab === 'overview' || !tabPath ? baseUrl : `${baseUrl}/${tabPath}`;
}
