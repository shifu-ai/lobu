export function asRecordObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// buildSampleFromTemplate – walk a json_template tree and synthesise sample
// data for every data-binding path so the preview always has something to show.
// ---------------------------------------------------------------------------

function sampleValueForPath(path: string): unknown {
  const label = path
    .split('.')
    .pop()!
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (label.includes('count') || label.includes('number') || label.includes('total')) return 42;
  if (label.includes('percent') || label.includes('score') || label.includes('rate')) return 75;
  if (label.includes('url') || label.includes('link')) return 'https://example.com';
  if (label.includes('date') || label.includes('time')) return '2026-01-15';
  if (label.includes('title') || label.includes('name')) return `Sample ${label}`;
  if (label.includes('summary') || label.includes('description'))
    return 'Sample summary of the key findings.';
  return `Sample ${label}`;
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) cur[last] = value;
}

type LoopCtx = Map<string, { itemsPath: string; itemSample: Record<string, unknown> }>;

function walkTemplate(node: unknown, result: Record<string, unknown>, loops: LoopCtx): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;

  // data binding
  if (n.type === 'data' && typeof n.path === 'string') {
    const root = n.path.split('.')[0];
    const loop = loops.get(root);
    if (loop) {
      const rest = n.path.slice(root.length + 1);
      if (rest) setNested(loop.itemSample, rest, sampleValueForPath(rest));
    } else {
      setNested(result, n.path, sampleValueForPath(n.path));
    }
    return;
  }

  // conditional – mark the condition truthy so the "then" branch renders
  if (n.type === 'if' && typeof n.condition === 'string') {
    const root = n.condition.split('.')[0];
    if (!loops.has(root)) setNested(result, n.condition, true);
    walkTemplate(n.then, result, loops);
    if (n.else) walkTemplate(n.else, result, loops);
    return;
  }

  // each loop – collect inner paths into an item sample, then place array
  if (n.type === 'each' && typeof n.items === 'string' && typeof n.as === 'string') {
    const itemSample: Record<string, unknown> = {};
    const innerLoops: LoopCtx = new Map(loops);
    innerLoops.set(n.as, { itemsPath: n.items, itemSample });
    walkTemplate(n.render, result, innerLoops);

    const itemsRoot = n.items.split('.')[0];
    if (!loops.has(itemsRoot)) {
      setNested(result, n.items, [itemSample, { ...itemSample }]);
    }
    return;
  }

  // props with {{ path }} bindings
  if (n.props && typeof n.props === 'object') {
    for (const val of Object.values(n.props as Record<string, unknown>)) {
      if (typeof val === 'string' && val.startsWith('{{') && val.endsWith('}}')) {
        const path = val.slice(2, -2).trim();
        const root = path.split('.')[0];
        const loop = loops.get(root);
        if (loop) {
          const rest = path.slice(root.length + 1);
          if (rest) setNested(loop.itemSample, rest, sampleValueForPath(rest));
        } else {
          setNested(result, path, sampleValueForPath(path));
        }
      }
    }
  }

  // recurse into children
  if (Array.isArray(n.children)) {
    for (const child of n.children) walkTemplate(child, result, loops);
  }
}

export function buildSampleFromTemplate(template: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  walkTemplate(template, result, new Map());
  return result;
}

/** Deep-merge two records. Values in `over` take precedence. */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] !== null &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function humanizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function getFirstArrayValue(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
}

function hasOwn(objectValue: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(objectValue, key);
}

export function buildSampleFromSchema(schema: unknown, fieldName = 'value'): unknown {
  const node = asRecordObject(schema);
  if (!node) return {};

  if (hasOwn(node, 'example')) return node.example;

  const firstExample = getFirstArrayValue(node.examples);
  if (firstExample !== undefined) return firstExample;

  if (hasOwn(node, 'default')) return node.default;
  if (hasOwn(node, 'const')) return node.const;

  const unionOptions = getFirstArrayValue(node.oneOf) ?? getFirstArrayValue(node.anyOf);
  if (unionOptions) {
    return buildSampleFromSchema(unionOptions, fieldName);
  }

  const enumValues = Array.isArray(node.enum) ? node.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues[0];
  }

  const type =
    typeof node.type === 'string'
      ? node.type
      : asRecordObject(node.properties)
        ? 'object'
        : undefined;

  if (type === 'object') {
    const properties = asRecordObject(node.properties);
    if (!properties) return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      result[key] = buildSampleFromSchema(value, key);
    }
    return result;
  }

  if (type === 'array') {
    const minItems = typeof node.minItems === 'number' && node.minItems > 0 ? node.minItems : 2;
    const itemSample = buildSampleFromSchema(node.items, fieldName);
    return Array.from({ length: Math.min(minItems, 3) }, () => itemSample);
  }

  if (type === 'number' || type === 'integer') {
    if (typeof node.minimum === 'number') return node.minimum;
    return 1;
  }
  if (type === 'boolean') return false;
  if (type === 'null') return null;

  if (type === 'string') {
    const format = typeof node.format === 'string' ? node.format : '';
    if (format === 'date') return '2026-01-01';
    if (format === 'date-time') return '2026-01-01T00:00:00Z';
    if (format === 'uri' || format === 'url') return 'https://example.com';
    if (format === 'email') return 'user@example.com';
    if (format === 'uuid') return '00000000-0000-4000-8000-000000000000';

    const label = humanizeFieldName(fieldName);
    if (!label) return 'Example value';
    if (label.includes('summary')) return 'Sample summary of the key findings.';
    if (label.includes('title')) return 'Sample watcher title';
    if (label.includes('description')) return 'Sample description text';
    if (label.includes('reason')) return 'Sample reason';
    return `Sample ${label}`;
  }

  return {};
}
