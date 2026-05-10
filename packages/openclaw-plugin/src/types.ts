/**
 * Plugin configuration types for the Lobu OpenClaw plugin.
 */

export interface MemoryWikiCompatConfig {
  /** Enable OpenClaw memory-wiki compatible tools backed by Lobu MCP primitives. */
  enabled?: boolean;
}

export interface PluginConfig {
  mcpUrl?: string;
  webUrl?: string;
  token?: string;
  tokenCommand?: string;
  gatewayAuthUrl?: string;
  headers?: Record<string, string>;
  autoRecall?: boolean;
  autoCapture?: boolean;
  recallLimit?: number;
  /** Spike/compat mode: register wiki_* and memory_* aliases without changing Lobu MCP. */
  memoryWikiCompat?: boolean | MemoryWikiCompatConfig;
}

export interface ResolvedPluginConfig {
  mcpUrl: string | null;
  webUrl: string | null;
  token: string | null;
  tokenCommand: string | null;
  gatewayAuthUrl: string | null;
  headers: Record<string, string>;
  autoRecall: boolean;
  autoCapture: boolean;
  recallLimit: number;
  memoryWikiCompat: {
    enabled: boolean;
  };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResponse {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}
