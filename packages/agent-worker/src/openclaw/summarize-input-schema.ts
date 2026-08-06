/**
 * Compact JSON Schema → model-readable parameter digest.
 *
 * The semantic tool router (tool_search / tool_status / tool_call) never
 * hands a tool's parameter schema to the model — `tool_call` declares
 * `args` as an untyped record. When a delegated call fails on argument
 * shape the model has nothing to correct against (see agent-stack #86,
 * where four consecutive calls sent `schedule_id` for a field named `id`).
 *
 * This digest is attached to argument-shaped failures only. It is
 * deliberately lossy: a raw schema can run to several KB and would crowd
 * out the turn's context.
 */

const MAX_SUMMARY_BYTES = 3072;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_ENUM_VALUES = 12;

export interface SummarizedField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
}

export interface InputSchemaSummary {
  required: string[];
  fields: SummarizedField[];
  truncated: boolean;
  unknownKeysSent?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaProperties(
  inputSchema: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(inputSchema)) return undefined;
  return isRecord(inputSchema.properties) ? inputSchema.properties : undefined;
}

/**
 * One-level type label. Nested objects report `"object"` rather than
 * recursing — the goal is to name the field, not reproduce the schema.
 */
function describeType(node: Record<string, unknown>): string {
  if (typeof node.type === "string") return node.type;
  if (Array.isArray(node.type)) {
    const names = node.type.filter((t): t is string => typeof t === "string");
    if (names.length > 0) return names.join("|");
  }
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches)) {
    const names: string[] = [];
    for (const branch of branches) {
      const name = isRecord(branch) ? describeType(branch) : "unknown";
      if (!names.includes(name)) names.push(name);
    }
    if (names.length > 0) return names.join("|");
  }
  if (node.const !== undefined) return typeof node.const;
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return typeof node.enum[0];
  }
  return "unknown";
}

function enumValues(node: Record<string, unknown>): unknown[] | undefined {
  if (node.const !== undefined) return [node.const];
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.slice(0, MAX_ENUM_VALUES);
  }
  return undefined;
}

export function unknownTopLevelKeys(
  inputSchema: unknown,
  args: Record<string, unknown>
): string[] {
  const properties = schemaProperties(inputSchema);
  if (!properties) return [];
  return Object.keys(args).filter(
    (key) => !Object.prototype.hasOwnProperty.call(properties, key)
  );
}

export function summarizeInputSchemaForModel(
  inputSchema: unknown,
  options: { argsSent?: Record<string, unknown> } = {}
): InputSchemaSummary | undefined {
  const properties = schemaProperties(inputSchema);
  if (!properties) return undefined;

  const declaredRequired =
    isRecord(inputSchema) && Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((v): v is string => typeof v === "string")
      : [];
  const requiredSet = new Set(declaredRequired);

  const all: SummarizedField[] = Object.entries(properties).map(
    ([name, raw]) => {
      const node = isRecord(raw) ? raw : {};
      const description =
        typeof node.description === "string"
          ? node.description.slice(0, MAX_DESCRIPTION_CHARS)
          : undefined;
      const values = enumValues(node);
      return {
        name,
        type: describeType(node),
        required: requiredSet.has(name),
        ...(description === undefined ? {} : { description }),
        ...(values === undefined ? {} : { enum: values }),
      };
    }
  );

  // Required first, then declaration order — truncation must never drop a
  // required field while keeping an optional one.
  const ordered = [
    ...all.filter((f) => f.required),
    ...all.filter((f) => !f.required),
  ];

  const fields: SummarizedField[] = [];
  let bytes = 0;
  let truncated = false;
  for (const field of ordered) {
    const size = Buffer.byteLength(JSON.stringify(field), "utf8");
    if (fields.length > 0 && bytes + size > MAX_SUMMARY_BYTES) {
      truncated = true;
      break;
    }
    fields.push(field);
    bytes += size;
  }

  const unknownKeysSent = options.argsSent
    ? unknownTopLevelKeys(inputSchema, options.argsSent)
    : [];

  return {
    required: declaredRequired,
    fields,
    truncated,
    ...(unknownKeysSent.length > 0 ? { unknownKeysSent } : {}),
  };
}
