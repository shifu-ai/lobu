#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import type { ConversationStateStore } from "../connections/conversation-state-store.js";
import {
  type ActiveCourseBinding,
  type ActiveCourseBindingWriteResult,
  computeSessionKey,
  type ISessionManager,
  type SessionStore,
  type ThreadSession,
} from "../session.js";

const logger = createLogger("session-manager");

/**
 * Session storage backed by the shared conversation state layer.
 * Thread sessions and chat history share the same StateAdapter-backed
 * storage abstraction.
 */
export class StateAdapterSessionStore implements SessionStore {
  constructor(private readonly conversations: ConversationStateStore) {}

  async get(sessionKey: string): Promise<ThreadSession | null> {
    try {
      return await this.conversations.getSession(sessionKey);
    } catch (error) {
      logger.error(`Failed to get session ${sessionKey}:`, error);
      return null;
    }
  }

  async set(sessionKey: string, session: ThreadSession): Promise<void> {
    await this.conversations.setSession(sessionKey, session);
    logger.debug(`Stored session ${sessionKey}`);
  }

  async delete(sessionKey: string): Promise<void> {
    await this.conversations.deleteSession(sessionKey);
    logger.debug(`Deleted session ${sessionKey}`);
  }

  async mutate(
    sessionKey: string,
    update: (session: ThreadSession) => ThreadSession
  ): Promise<boolean> {
    return this.conversations.mutateSession(sessionKey, update);
  }

  async getByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    try {
      return await this.conversations.getSessionByThread(channelId, threadTs);
    } catch (error) {
      logger.error(
        `Failed to get session by thread ${channelId}:${threadTs}:`,
        error
      );
      return null;
    }
  }

  /** Optional cleanup - state adapter TTL handles this automatically */
  async cleanup?(): Promise<number> {
    logger.debug("StateAdapter TTL handles automatic cleanup");
    return 0;
  }
}

/**
 * Session manager that abstracts session storage
 * Provides thread ownership validation and session lifecycle management
 */
export class SessionManager implements ISessionManager {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /**
   * Create a new session
   */
  async createSession(
    channelId: string,
    userId: string,
    conversationId?: string,
    threadCreator?: string
  ): Promise<ThreadSession> {
    const effectiveConversationId = conversationId || userId;
    const session: ThreadSession = {
      conversationId: effectiveConversationId,
      channelId,
      userId,
      threadCreator: threadCreator || userId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    const sessionKey = computeSessionKey(session);
    await this.store.set(sessionKey, session);
    return session;
  }

  /**
   * Update session
   */
  async updateSession(
    sessionKey: string,
    updates: Partial<ThreadSession>
  ): Promise<void> {
    await this.store.mutate(sessionKey, (session) => ({ ...session, ...updates }));
  }

  /**
   * Get session by session key
   */
  async getSession(sessionKey: string): Promise<ThreadSession | null> {
    return await this.store.get(sessionKey);
  }

  /**
   * Create or update a session
   */
  async setSession(session: ThreadSession): Promise<void> {
    const sessionKey = computeSessionKey(session);
    await this.store.set(sessionKey, session);
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionKey: string): Promise<void> {
    await this.store.delete(sessionKey);
  }

  /**
   * Find session by thread
   */
  async findSessionByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    return await this.store.getByThread(channelId, threadTs);
  }

  /**
   * Validate thread ownership
   * Returns true if the user is the thread creator or no session exists
   */
  async validateThreadOwnership(
    channelId: string,
    threadTs: string,
    userId: string
  ): Promise<{ allowed: boolean; owner?: string }> {
    const session = await this.findSessionByThread(channelId, threadTs);

    if (!session) {
      return { allowed: true }; // No session, allow creation
    }

    if (!session.threadCreator) {
      return { allowed: true }; // No owner set, allow
    }

    if (session.threadCreator === userId) {
      return { allowed: true, owner: session.threadCreator };
    }

    return { allowed: false, owner: session.threadCreator };
  }

  /**
   * Update session activity timestamp
   */
  async touchSession(sessionKey: string): Promise<void> {
    await this.store.mutate(sessionKey, (session) => ({
      ...session,
      lastActivity: Date.now(),
    }));
  }

  /**
   * Cleanup expired sessions (for in-memory stores)
   * Note: state-adapter-backed stores handle this automatically via TTL
   */
  async cleanupExpired(ttl: number): Promise<number> {
    return (await this.store.cleanup?.(ttl)) || 0;
  }

  /** Shared StateAdapter read-merge-write; follows existing last-write semantics. */
  async bindActiveCourse(sessionKey: string, binding: ActiveCourseBinding): Promise<ActiveCourseBindingWriteResult> {
    try {
      const updated = await this.store.mutate(sessionKey, (session) => ({
        ...session,
        shifuCourseContext: binding,
      }));
      if (!updated) return { status: "binding_write_failed", code: "binding_write_failed" };
      return { status: "persisted" };
    } catch (error) {
      logger.error(`Failed to bind active course for session ${sessionKey}:`, error);
      return { status: "binding_write_failed", code: "binding_write_failed" };
    }
  }

  async clearActiveCourse(sessionKey: string): Promise<ActiveCourseBindingWriteResult> {
    try {
      const updated = await this.store.mutate(sessionKey, (session) => {
        const { shifuCourseContext: _removed, ...remaining } = session;
        return remaining;
      });
      if (!updated) return { status: "binding_write_failed", code: "binding_write_failed" };
      return { status: "persisted" };
    } catch (error) {
      logger.error(`Failed to clear active course for session ${sessionKey}:`, error);
      return { status: "binding_write_failed", code: "binding_write_failed" };
    }
  }

  async setPendingCourseSelection(sessionKey: string, pending: NonNullable<ThreadSession["pendingCourseSelection"]>): Promise<boolean> {
    return this.store.mutate(sessionKey, (session) => ({ ...session, pendingCourseSelection: pending }));
  }

  async takePendingCourseSelection(sessionKey: string): Promise<{ success: boolean; pending?: ThreadSession["pendingCourseSelection"] }> {
    let pending: ThreadSession["pendingCourseSelection"];
    try { const success = await this.store.mutate(sessionKey, (session) => { pending = session.pendingCourseSelection; const { pendingCourseSelection: _removed, ...remaining } = session; return remaining; }); return { success, pending }; } catch { return { success: false }; }
  }
}
