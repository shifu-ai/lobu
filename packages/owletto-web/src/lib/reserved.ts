import type { EntityTabName } from '@/components/entity-tabs/types';

/**
 * Owner-level route segments that map to real app pages under /$owner/.
 * Must stay in sync with src/utils/reserved.ts on the backend.
 */
export const OWNER_ROUTE_SEGMENTS = [
  'agents',
  'connectors',
  'events',
  'members',
  'settings',
  'watchers',
] as const;

export const RESERVED_PATHS = [
  ...OWNER_ROUTE_SEGMENTS,
  'auth',
  'api',
  'templates',
  'help',
  'account',
  'admin',
  'health',
  'login',
  'logout',
  'signup',
  'register',
  'sources',
  'contents',
  'entity-types',
];

/**
 * Reserved entity type slugs — users cannot create entity types with these names.
 * Mirrors backend RESERVED_ENTITY_TYPES.
 */
export const RESERVED_ENTITY_TYPES = [
  ...OWNER_ROUTE_SEGMENTS,
  'organization',
  'user',
  'watcher',
  'content',
  'source',
  'sources',
  'connections',
  'connector',
];

/** Valid tab names used for entity pages and tab parsing. */
export const VALID_TABS: EntityTabName[] = ['overview', 'connectors', 'events', 'watchers'];

/** Entity type slugs hidden from sidebar and entity-type card lists. */
export const HIDDEN_ENTITY_TYPE_SLUGS = new Set([
  'organization',
  'user',
  '$member',
  'watcher',
  'watchers',
  'content',
  'source',
  'sources',
]);
