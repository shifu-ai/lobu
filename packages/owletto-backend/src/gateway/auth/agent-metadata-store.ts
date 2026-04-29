import { BaseRedisStore, createLogger } from "@lobu/core";
import type { Redis } from "ioredis";

const logger = createLogger("agent-metadata-store");

/**
 * Agent metadata - user-facing info about an agent
 */
export interface AgentMetadata {
  agentId: string;
  /** User-friendly name (e.g., "Work Agent", "Personal Assistant") */
  name: string;
  description?: string;
  owner: {
    platform: string;
    userId: string;
  };
  /** Whether this is the workspace default agent */
  isWorkspaceAgent?: boolean;
  /** Workspace/team ID for workspace agents */
  workspaceId?: string;
  /** Connection that auto-created this agent (makes it a "sandbox") */
  parentConnectionId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/**
 * Store agent metadata in Redis.
 * Pattern: agent_metadata:{agentId}
 */
export class AgentMetadataStore extends BaseRedisStore<AgentMetadata> {
  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "agent_metadata",
      loggerName: "agent-metadata-store",
    });
  }

  /**
   * Create a new agent with metadata
   */
  async createAgent(
    agentId: string,
    name: string,
    platform: string,
    userId: string,
    options?: {
      description?: string;
      isWorkspaceAgent?: boolean;
      workspaceId?: string;
      parentConnectionId?: string;
    }
  ): Promise<AgentMetadata> {
    const metadata: AgentMetadata = {
      agentId,
      name,
      owner: { platform, userId },
      isWorkspaceAgent: options?.isWorkspaceAgent,
      workspaceId: options?.workspaceId,
      parentConnectionId: options?.parentConnectionId,
      createdAt: Date.now(),
    };

    if (options?.description) {
      metadata.description = options.description;
    }

    const key = this.buildKey(agentId);
    await this.set(key, metadata);

    // Index sandbox under its parent connection
    if (options?.parentConnectionId) {
      await this.redis.sadd(
        `sandboxes:connection:${options.parentConnectionId}`,
        agentId
      );
    }

    logger.info(`Created agent metadata for ${agentId}: "${name}"`);
    return metadata;
  }

  /**
   * Get metadata for an agent
   */
  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    const key = this.buildKey(agentId);
    return this.get(key);
  }

  /**
   * Update agent metadata (partial update)
   */
  async updateMetadata(
    agentId: string,
    updates: Partial<Pick<AgentMetadata, "name" | "description" | "lastUsedAt">>
  ): Promise<void> {
    const existing = await this.getMetadata(agentId);
    if (!existing) {
      logger.warn(`Cannot update metadata: agent ${agentId} not found`);
      return;
    }

    const updated: AgentMetadata = { ...existing, ...updates };
    const key = this.buildKey(agentId);
    await this.set(key, updated);
    logger.info(`Updated metadata for agent ${agentId}`);
  }

  /**
   * Delete agent metadata
   */
  async deleteAgent(agentId: string): Promise<void> {
    // Clean up sandbox index if this agent has a parent connection
    const metadata = await this.getMetadata(agentId);
    if (metadata?.parentConnectionId) {
      await this.redis.srem(
        `sandboxes:connection:${metadata.parentConnectionId}`,
        agentId
      );
    }

    const key = this.buildKey(agentId);
    await this.delete(key);
    logger.info(`Deleted metadata for agent ${agentId}`);
  }

  /**
   * Check if agent exists
   */
  async hasAgent(agentId: string): Promise<boolean> {
    const key = this.buildKey(agentId);
    return this.exists(key);
  }

  /**
   * List sandbox agents belonging to a connection
   */
  async listSandboxes(connectionId: string): Promise<AgentMetadata[]> {
    const agentIds = await this.redis.smembers(
      `sandboxes:connection:${connectionId}`
    );
    const sandboxes: AgentMetadata[] = [];
    for (const agentId of agentIds) {
      const data = await this.getMetadata(agentId);
      if (data) sandboxes.push(data);
    }
    sandboxes.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return sandboxes;
  }

  /**
   * List all agents in the system, sorted by lastUsedAt descending
   */
  async listAllAgents(): Promise<AgentMetadata[]> {
    const prefix = `${this.keyPrefix}:`;
    const keys = await this.scanByPrefix(prefix);
    const agents: AgentMetadata[] = [];
    for (const key of keys) {
      const data = await this.get(key);
      if (data) agents.push(data);
    }
    agents.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return agents;
  }
}
