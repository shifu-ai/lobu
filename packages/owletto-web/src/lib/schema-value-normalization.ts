interface SchemaProperty {
  enum?: string[];
}

interface JsonSchemaObject {
  properties?: Record<string, SchemaProperty>;
}

export function normalizeEnumValue(value: unknown, options?: readonly string[]): unknown {
  if (typeof value !== 'string' || !options || options.length === 0) {
    return value;
  }

  const trimmed = value.trim();
  if (options.includes(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string' && options.includes(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore non-JSON string values.
  }

  return value;
}

export function normalizeMetadataForSchema(
  metadata: Record<string, unknown> | null | undefined,
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const properties = (schema as JsonSchemaObject | null | undefined)?.properties;
  if (!properties) {
    return { ...metadata };
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      normalizeEnumValue(value, properties[key]?.enum),
    ])
  );
}
