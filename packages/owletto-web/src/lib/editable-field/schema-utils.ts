import type { JsonSchema } from '@jsonforms/core';

/**
 * Walk a JSON Schema following a dot/bracket path into the data, returning
 * the schema for the addressed value. Used so the editable-field tooling can
 * fetch the per-item schema when the path lands on (or inside) an array.
 *
 * Path examples:
 *   "problems"           → schema for the array
 *   "problems[0]"        → schema for an item in the array (the items schema)
 *   "problems[0].name"   → schema for the leaf field "name"
 *   "metrics.revenue"    → schema for nested object property "revenue"
 *
 * Returns undefined if any segment can't be resolved against the schema —
 * callers should fall back to a free-form input.
 */
export function resolveSchemaForPath(
  rootSchema: JsonSchema | undefined,
  path: string
): JsonSchema | undefined {
  if (!rootSchema || !path) return rootSchema;
  let cur: JsonSchema | undefined = rootSchema;
  // Tokenize: keep array brackets as their own steps so we can recurse into
  // `items` deterministically (`problems[0]` → ["problems", "[0]"]).
  const tokens = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const token of tokens) {
    if (!cur) return undefined;
    if (/^\[\d+\]$/.test(token)) {
      if (cur.type !== 'array' || !cur.items) return undefined;
      cur = Array.isArray(cur.items) ? cur.items[0] : (cur.items as JsonSchema);
      continue;
    }
    if (cur.type === 'object' || cur.properties) {
      const next = cur.properties?.[token];
      if (!next) return undefined;
      cur = next as JsonSchema;
      continue;
    }
    return undefined;
  }
  return cur;
}

/**
 * Given the schema for an array, return the schema for one item.
 * Used by the "Add new item" form.
 */
export function resolveItemSchemaForArrayPath(
  rootSchema: JsonSchema | undefined,
  arrayPath: string
): JsonSchema | undefined {
  const arraySchema = resolveSchemaForPath(rootSchema, arrayPath);
  if (!arraySchema || arraySchema.type !== 'array' || !arraySchema.items) {
    return undefined;
  }
  return Array.isArray(arraySchema.items)
    ? (arraySchema.items[0] as JsonSchema)
    : (arraySchema.items as JsonSchema);
}
