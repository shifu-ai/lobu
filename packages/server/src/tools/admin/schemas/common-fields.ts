/**
 * Shared TypeBox field definitions for admin tool schemas.
 *
 * These are spread into tool-specific schemas to avoid repeating
 * identical limit/offset/entity_id patterns across files.
 */

import { Type } from '@sinclair/typebox';

/** Standard pagination fields with sensible defaults. */
export const PaginationFields = {
  limit: Type.Optional(Type.Number({ description: 'Page size (default: 100)', default: 100 })),
  offset: Type.Optional(Type.Number({ description: 'Pagination offset (default: 0)', default: 0 })),
};

/** Optional `asc`/`desc` sort-order field with a tool-specific description. */
export function SortOrderField(description: string) {
  return Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')], { description }));
}

