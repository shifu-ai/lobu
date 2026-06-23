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
}

export interface ProjectedMcpTools {
  tools: Record<string, ProjectedMcpToolDef[]>;
  projected: ProjectionNotice[];
  quarantined: ProjectionNotice[];
  omittedForCap: CapNotice[];
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      notice(keyword);
      return { ...PROJECTED_UNION_SCHEMA };
    }
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
  if (reservedNames.has(safeName)) {
    safeName = withStableSuffix(safeName, name);
  }
  return safeName;
}

export function requiresProviderSafeToolNames(provider: string): boolean {
  const normalized = provider.toLowerCase();
  return normalized === "gemini" || normalized === "google";
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

function rootUnsupportedKeyword(schema: Record<string, unknown>): string | null {
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

export function projectMcpToolsForProvider(
  mcpTools: Record<string, McpToolDef[]>,
  options: ProjectMcpToolsOptions
): ProjectedMcpTools {
  const projected: ProjectionNotice[] = [];
  const quarantined: ProjectionNotice[] = [];
  const flattened: FlattenedTool[] = [];
  const reservedProviderToolNames = new Set<string>();
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

      flattened.push({
        mcpId,
        tool: projectToolNameForProvider(
          normalizedTool,
          options.provider,
          reservedProviderToolNames
        ),
        sortName: toolName,
        originalIndex,
      });
      originalIndex += 1;
    }
  }

  const sorted = flattened.sort((a, b) => {
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
