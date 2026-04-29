import { BaseRedisStore } from "@lobu/core";
import type { Redis } from "ioredis";

/**
 * Store and retrieve user's model preference from Redis
 * Pattern: {providerId}:model_preference:{userId}
 */
export class ModelPreferenceStore extends BaseRedisStore<string> {
  constructor(redis: Redis, providerId: string) {
    super({
      redis,
      keyPrefix: `${providerId}:model_preference`,
      loggerName: `${providerId}-model-preference`,
    });
  }

  /**
   * Set user's model preference
   */
  async setModelPreference(userId: string, model: string): Promise<void> {
    const key = this.buildKey(userId);
    await this.set(key, model);
    this.logger.info(`Set model preference for user ${userId}: ${model}`);
  }

  /**
   * Get user's model preference
   * Returns null if no preference is set
   */
  async getModelPreference(userId: string): Promise<string | null> {
    const key = this.buildKey(userId);
    return this.get(key);
  }

  /**
   * Delete user's model preference
   */
  async deleteModelPreference(userId: string): Promise<void> {
    const key = this.buildKey(userId);
    await this.delete(key);
    this.logger.info(`Deleted model preference for user ${userId}`);
  }

  // Override serialize/deserialize for simple string values
  protected override serialize(value: string): string {
    return value; // Store as plain string, not JSON
  }

  protected override deserialize(data: string): string {
    return data; // Return as plain string
  }
}
