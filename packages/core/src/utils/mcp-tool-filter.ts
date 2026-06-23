import type { McpToolFilter } from "../types";

interface NamedMcpTool {
  name: string;
}

export function applyMcpToolFilter<T extends NamedMcpTool>(
  tools: T[],
  filter?: McpToolFilter
): T[] {
  const include = filter?.include?.filter(Boolean) ?? [];
  const exclude = filter?.exclude?.filter(Boolean) ?? [];

  const included =
    include.length === 0
      ? tools
      : tools.filter((tool) => matchesAnyPattern(tool.name, include));

  if (exclude.length === 0) {
    return included;
  }

  return included.filter((tool) => !matchesAnyPattern(tool.name, exclude));
}

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return value === pattern;
  }

  const regex = new RegExp(`^${escapeRegex(pattern).replace(/\*/g, ".*")}$`);
  return regex.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
