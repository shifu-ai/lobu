import { createLogger, getJsonValue, setJsonValue } from "@lobu/core";

const logger = createLogger("mcp-tool-cache");

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface CachedMcpServer {
  tools: McpTool[];
  instructions?: string;
}

const CACHE_TTL_SECONDS = 300; // 5 minutes

export class McpToolCache {
  constructor(private readonly redisClient: any) {}

  async get(mcpId: string, agentId?: string): Promise<McpTool[] | null> {
    const info = await this.getServerInfo(mcpId, agentId);
    return info ? info.tools : null;
  }

  async set(mcpId: string, tools: McpTool[], agentId?: string): Promise<void> {
    await this.setServerInfo(mcpId, { tools }, agentId);
  }

  async getServerInfo(
    mcpId: string,
    agentId?: string
  ): Promise<CachedMcpServer | null> {
    const key = this.buildKey(mcpId, agentId);
    try {
      const parsed = await getJsonValue<CachedMcpServer>(this.redisClient, key);
      if (!parsed) {
        return null;
      }
      return parsed;
    } catch (error) {
      logger.error("Failed to read tool cache", { key, error });
      return null;
    }
  }

  async setServerInfo(
    mcpId: string,
    info: CachedMcpServer,
    agentId?: string
  ): Promise<void> {
    const key = this.buildKey(mcpId, agentId);
    try {
      await setJsonValue(this.redisClient, key, info, CACHE_TTL_SECONDS);
    } catch (error) {
      logger.error("Failed to write tool cache", { key, error });
    }
  }

  async getInstructions(
    mcpId: string,
    agentId?: string
  ): Promise<string | undefined> {
    const info = await this.getServerInfo(mcpId, agentId);
    return info?.instructions;
  }

  private buildKey(mcpId: string, agentId?: string): string {
    if (agentId) {
      return `mcp:tools:${agentId}:${mcpId}`;
    }
    return `mcp:tools:${mcpId}`;
  }
}
