import type { McpToolDef } from "@lobu/core";

export interface ProjectionNotice {
  mcpId: string;
  toolName: string;
  reason: string;
}

export interface CapNotice {
  mcpId: string;
  omitted: number;
  limit: number;
}

export interface ProjectedMcpToolDef extends McpToolDef {
  upstreamToolName?: string;
  providerToolName?: string;
  providerSafeNameOnly?: true;
}

export interface McpAuthToolNames {
  login: string;
  loginCheck: string;
  logout: string;
}

export interface ProjectMcpToolsOptions {
  provider: string;
  directToolLimit: number;
  reservedProviderToolNames?: Set<string>;
  selectionHint?: string;
}

export interface ProjectedMcpTools {
  tools: Record<string, ProjectedMcpToolDef[]>;
  projected: ProjectionNotice[];
  quarantined: ProjectionNotice[];
  omittedForCap: CapNotice[];
}

const MCP_TOOL_DESCRIPTION_NOTES: Record<string, Record<string, string>> = {
  notion: {
    "notion-update-page":
      "IMPORTANT: This tool CANNOT delete, archive, or trash pages. The allow_deleting_content parameter only guards child-page removal during content edits. There is no way to delete a Notion page through this MCP — tell the user to delete it manually instead of attempting it with this tool.",
    "notion-move-pages":
      "IMPORTANT: This tool CANNOT move pages to trash. Valid destinations are pages, databases, and the workspace only — it cannot delete or archive anything.",
  },
};

function applyCapabilityLimitNote<T extends { description?: string }>(
  mcpId: string,
  upstreamToolName: string,
  tool: T
): T {
  const note = MCP_TOOL_DESCRIPTION_NOTES[mcpId]?.[upstreamToolName];
  if (!note) {
    return tool;
  }
  const existingDescription = tool.description?.trim();
  if (existingDescription && existingDescription.includes(note)) {
    // Already applied (e.g. cli-exposure path ran before the projection
    // path also touched this tool) — skip to avoid duplicating the note.
    return tool;
  }
  const description = existingDescription
    ? `${existingDescription}\n\n${note}`
    : note;
  return { ...tool, description };
}

/**
 * Bulk variant of {@link applyCapabilityLimitNote} for exposure paths that
 * bypass `projectMcpToolsForProvider` entirely (e.g. `mcpExposure: "cli"`,
 * where raw `mcpTools` flow straight to the just-bash `<mcpId> --help`
 * renderer). Idempotent — safe to call more than once, and harmless to call
 * on tools that also pass through the projection path.
 */
export function applyCapabilityLimitNotes(
  mcpTools: Record<string, McpToolDef[]>
): Record<string, McpToolDef[]> {
  const result: Record<string, McpToolDef[]> = {};
  for (const [mcpId, tools] of Object.entries(mcpTools)) {
    result[mcpId] = tools.map((tool) =>
      applyCapabilityLimitNote(mcpId, tool.name, tool)
    );
  }
  return result;
}

const UNION_KEYWORDS = new Set(["anyOf", "oneOf", "allOf"]);
const PROJECTED_UNION_SCHEMA = {
  type: "string",
  description: "Projected from unsupported MCP schema union.",
};
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };
const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

interface FlattenedTool {
  mcpId: string;
  tool: ProjectedMcpToolDef;
  sortName: string;
  originalIndex: number;
  relevanceScore: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfConstValue(value: unknown): string | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return null;
}

function projectUnionSchema(
  value: Record<string, unknown>,
  notice: (keyword: string) => void
): Record<string, unknown> {
  const keyword = [...UNION_KEYWORDS].find((entry) =>
    Object.hasOwn(value, entry)
  );
  if (!keyword) {
    return value;
  }

  notice(keyword);
  const variants = Array.isArray(value[keyword]) ? value[keyword] : [];
  const literalValues: unknown[] = [];
  let literalType: string | null = null;
  let allVariantsAreSameTypedLiterals = variants.length > 0;

  for (const variant of variants) {
    if (!isRecord(variant) || !Object.hasOwn(variant, "const")) {
      allVariantsAreSameTypedLiterals = false;
      break;
    }
    const constValue = variant.const;
    const constType = typeOfConstValue(constValue);
    if (!constType) {
      allVariantsAreSameTypedLiterals = false;
      break;
    }
    literalType ??= constType;
    if (literalType !== constType) {
      allVariantsAreSameTypedLiterals = false;
      break;
    }
    literalValues.push(constValue);
  }

  if (allVariantsAreSameTypedLiterals && literalType) {
    return {
      type: literalType,
      enum: literalValues,
      description:
        typeof value.description === "string"
          ? value.description
          : PROJECTED_UNION_SCHEMA.description,
    };
  }

  return { ...PROJECTED_UNION_SCHEMA };
}

function projectSchemaNode(
  value: unknown,
  notice: (keyword: string) => void
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => projectSchemaNode(entry, notice));
  }

  if (!isRecord(value)) {
    return value;
  }

  for (const keyword of UNION_KEYWORDS) {
    if (Object.hasOwn(value, keyword)) {
      return projectUnionSchema(value, notice);
    }
  }

  if (Object.hasOwn(value, "const")) {
    notice("const");
    const constValue = value.const;
    const constType = typeOfConstValue(constValue);
    if (constType) {
      return {
        type: constType,
        enum: [constValue],
        description:
          typeof value.description === "string"
            ? value.description
            : "Projected from unsupported MCP schema const.",
      };
    }
    return { ...PROJECTED_UNION_SCHEMA };
  }

  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const projectedChild = projectSchemaNode(child, notice);
    projected[key] = projectedChild;
    changed ||= projectedChild !== child;
  }

  return changed ? projected : value;
}

function pushTool(
  grouped: Record<string, ProjectedMcpToolDef[]>,
  mcpId: string,
  tool: ProjectedMcpToolDef
): void {
  const tools = grouped[mcpId] ?? [];
  tools.push(tool);
  grouped[mcpId] = tools;
}

function toSafeAlias(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(HASH_SUFFIX_LENGTH, "0");
}

function withStableSuffix(baseName: string, sourceName: string): string {
  const suffix = hashString(sourceName).slice(0, HASH_SUFFIX_LENGTH);
  const maxBaseLength = MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length - 1;
  return `${baseName.slice(0, maxBaseLength)}_${suffix}`;
}

function withNumericSuffix(baseName: string, index: number): string {
  const suffix = `_${index}`;
  const maxBaseLength = MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length;
  return `${baseName.slice(0, maxBaseLength)}${suffix}`;
}

export function buildProviderSafeToolName(
  name: string,
  reservedNames: Set<string>
): string {
  const collapsed = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  let safeName = collapsed || "mcp_tool";
  if (!/^[A-Za-z_]/.test(safeName)) {
    safeName = `mcp_${safeName}`;
  }
  if (safeName.length > MAX_PROVIDER_TOOL_NAME_LENGTH) {
    safeName = withStableSuffix(safeName, name);
  }
  const baseSafeName = safeName;
  let duplicateIndex = 2;
  while (reservedNames.has(safeName)) {
    safeName = withNumericSuffix(baseSafeName, duplicateIndex);
    duplicateIndex += 1;
  }
  return safeName;
}

export function requiresProviderSafeToolNames(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return (
    normalized === "anthropic" ||
    normalized === "claude" ||
    normalized === "gemini" ||
    normalized === "google"
  );
}

export function buildMcpAuthToolNames(
  mcpId: string,
  options: {
    providerSafeNames?: boolean;
    reservedNames?: Set<string>;
  } = {}
): McpAuthToolNames {
  const reservedNames = options.reservedNames ?? new Set<string>();
  const buildName = (rawName: string): string => {
    const name =
      options.providerSafeNames === true
        ? buildProviderSafeToolName(rawName, reservedNames)
        : rawName;
    reservedNames.add(name);
    return name;
  };

  return {
    login: buildName(`${mcpId}_login`),
    loginCheck: buildName(`${mcpId}_login_check`),
    logout: buildName(`${mcpId}_logout`),
  };
}

function rootUnsupportedKeyword(
  schema: Record<string, unknown>
): string | null {
  for (const keyword of UNION_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      return keyword;
    }
  }
  return null;
}

function getNewDirectToolDefinitionNames(
  tool: ProjectedMcpToolDef,
  registeredNames: Set<string>
): string[] {
  const toolName = tool.name;
  if (tool.providerSafeNameOnly === true) {
    return registeredNames.has(toolName) ? [] : [toolName];
  }

  const names: string[] = [];
  if (!registeredNames.has(toolName)) {
    names.push(toolName);
  }
  const alias = toSafeAlias(toolName);
  if (alias !== toolName && !registeredNames.has(alias)) {
    names.push(alias);
  }
  return names;
}

function projectToolNameForProvider(
  tool: McpToolDef,
  provider: string,
  reservedProviderToolNames: Set<string>
): ProjectedMcpToolDef {
  const upstreamToolName = tool.name.trim();
  const providerToolName = buildProviderSafeToolName(
    upstreamToolName,
    reservedProviderToolNames
  );
  reservedProviderToolNames.add(providerToolName);
  if (
    requiresProviderSafeToolNames(provider) &&
    providerToolName !== upstreamToolName
  ) {
    return {
      ...tool,
      name: providerToolName,
      upstreamToolName,
      providerToolName,
      providerSafeNameOnly: true,
    };
  }
  return tool;
}

function normalizeInputSchema(
  inputSchema: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return { ...EMPTY_OBJECT_SCHEMA };
  }
  return inputSchema;
}

function buildSelectionTerms(value: string | undefined): Set<string> {
  const terms = new Set<string>();
  const normalized = (value ?? "").toLowerCase();
  for (const match of normalized.matchAll(/[a-z0-9_]{2,}/g)) {
    terms.add(match[0]);
  }
  const cjkChars = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let i = 0; i < cjkChars.length - 1; i += 1) {
    terms.add(`${cjkChars[i]}${cjkChars[i + 1]}`);
  }
  return terms;
}

function scoreToolRelevance(
  tool: McpToolDef,
  selectionTerms: Set<string>
): number {
  if (selectionTerms.size === 0) return 0;
  const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of selectionTerms) {
    if (haystack.includes(term)) {
      score += term.includes("_") ? 2 : 1;
    }
  }
  return score;
}

export function projectToolParametersForProvider<
  T extends { parameters?: unknown },
>(tools: T[], provider: string): T[] {
  if (!requiresProviderSafeToolNames(provider)) {
    return tools;
  }

  return tools.map((tool) => {
    if (!isRecord(tool.parameters)) {
      return tool;
    }
    const projected = projectSchemaNode(tool.parameters, () => undefined);
    if (projected === tool.parameters || !isRecord(projected)) {
      return tool;
    }
    return { ...tool, parameters: projected };
  });
}

export function projectMcpToolsForProvider(
  mcpTools: Record<string, McpToolDef[]>,
  options: ProjectMcpToolsOptions
): ProjectedMcpTools {
  const projected: ProjectionNotice[] = [];
  const quarantined: ProjectionNotice[] = [];
  const flattened: FlattenedTool[] = [];
  const reservedProviderToolNames = new Set(
    options.reservedProviderToolNames ?? []
  );
  const selectionTerms = buildSelectionTerms(options.selectionHint);
  let originalIndex = 0;

  for (const [mcpId, tools] of Object.entries(mcpTools)) {
    for (const tool of tools) {
      const toolName = tool.name;
      if (!toolName || typeof toolName !== "string" || !toolName.trim()) {
        continue;
      }
      const inputSchema = normalizeInputSchema(tool.inputSchema);

      if (inputSchema.type !== "object") {
        quarantined.push({
          mcpId,
          toolName,
          reason: "root schema must be an object",
        });
        continue;
      }

      const unsupportedRootKeyword = rootUnsupportedKeyword(inputSchema);
      if (unsupportedRootKeyword) {
        quarantined.push({
          mcpId,
          toolName,
          reason: `root schema uses unsupported keyword ${unsupportedRootKeyword}`,
        });
        continue;
      }

      const projectedSchema = projectSchemaNode(inputSchema, (keyword) => {
        projected.push({
          mcpId,
          toolName,
          reason: `removed unsupported keyword ${keyword}`,
        });
      });
      const normalizedTool =
        projectedSchema !== tool.inputSchema
          ? {
              ...tool,
              inputSchema: projectedSchema as Record<string, unknown>,
            }
          : tool;
      const annotatedTool = applyCapabilityLimitNote(
        mcpId,
        toolName,
        normalizedTool
      );

      flattened.push({
        mcpId,
        tool: projectToolNameForProvider(
          annotatedTool,
          options.provider,
          reservedProviderToolNames
        ),
        sortName: toolName,
        originalIndex,
        relevanceScore: scoreToolRelevance(normalizedTool, selectionTerms),
      });
      originalIndex += 1;
    }
  }

  const sorted = flattened.sort((a, b) => {
    const relevanceCompare = b.relevanceScore - a.relevanceScore;
    if (relevanceCompare !== 0) {
      return relevanceCompare;
    }
    const mcpCompare = a.mcpId.localeCompare(b.mcpId);
    if (mcpCompare !== 0) {
      return mcpCompare;
    }
    const toolCompare = a.sortName.localeCompare(b.sortName);
    if (toolCompare !== 0) {
      return toolCompare;
    }
    return a.originalIndex - b.originalIndex;
  });

  const limit = Math.max(0, Math.floor(options.directToolLimit));
  const accepted: FlattenedTool[] = [];
  const omitted: FlattenedTool[] = [];
  const registeredNames = new Set<string>();
  for (const entry of sorted) {
    const newDefinitionNames = getNewDirectToolDefinitionNames(
      entry.tool,
      registeredNames
    );
    if (
      newDefinitionNames.length === 0 ||
      registeredNames.size + newDefinitionNames.length > limit
    ) {
      omitted.push(entry);
      continue;
    }

    accepted.push(entry);
    for (const name of newDefinitionNames) {
      registeredNames.add(name);
    }
  }
  const tools: Record<string, ProjectedMcpToolDef[]> = {};
  for (const entry of accepted) {
    pushTool(tools, entry.mcpId, entry.tool);
  }
  const omittedCounts = new Map<string, number>();
  for (const entry of omitted) {
    omittedCounts.set(entry.mcpId, (omittedCounts.get(entry.mcpId) ?? 0) + 1);
  }
  const omittedForCap = Array.from(omittedCounts.entries()).map(
    ([mcpId, omitted]) => ({
      mcpId,
      omitted,
      limit,
    })
  );

  return {
    tools,
    projected,
    quarantined,
    omittedForCap,
  };
}
