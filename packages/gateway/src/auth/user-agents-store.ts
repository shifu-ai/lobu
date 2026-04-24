import { createLogger } from "@lobu/core";
import type { Redis } from "ioredis";

const logger = createLogger("user-agents-store");

/**
 * Track which agents belong to which users.
 * Uses Redis sets for fast membership checks and listing.
 *
 * Storage pattern:
 * - user_agents:{platform}:{userId} -> Set of agentIds
 */
export class UserAgentsStore {
  private readonly KEY_PREFIX = "user_agents";

  constructor(private redis: Redis) {}

  private buildKey(platform: string, userId: string): string {
    return `${this.KEY_PREFIX}:${platform}:${userId}`;
  }

  /**
   * Add an agent to a user's list
   */
  async addAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const key = this.buildKey(platform, userId);
    await this.redis.sadd(key, agentId);
    logger.info(`Added agent ${agentId} to user ${platform}/${userId}`);
  }

  /**
   * Remove an agent from a user's list
   */
  async removeAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const key = this.buildKey(platform, userId);
    await this.redis.srem(key, agentId);
    logger.info(`Removed agent ${agentId} from user ${platform}/${userId}`);
  }

  /**
   * List all agents owned by a user
   */
  async listAgents(platform: string, userId: string): Promise<string[]> {
    const key = this.buildKey(platform, userId);
    return this.redis.smembers(key);
  }

  /**
   * Check if a user owns a specific agent
   */
  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    const key = this.buildKey(platform, userId);
    const result = await this.redis.sismember(key, agentId);
    return result === 1;
  }
}
