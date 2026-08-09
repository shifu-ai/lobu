/**
 * InMemoryAgentStore — default AgentStore backed by in-memory Maps.
 *
 * Populated from files (dev mode) or via API (embedded mode). Raw CRUD
 * primitives operate on Maps; the public AgentStore surface is inherited
 * from BaseAgentStore.
 */

import {
  inferGrantKind,
  normalizeDomainPattern,
  type AgentMetadata,
  type AgentSettings,
  type ChannelBinding,
  type Grant,
  type StoredConnection,
} from "@lobu/core";
import {
  BaseAgentStore,
  buildKey,
  getOrCreateSet,
} from "./base-agent-store.js";

export class InMemoryAgentAggregateNotFoundError extends Error {
  readonly code = "embedded_agent_aggregate_not_found";

  constructor(readonly agentId: string) {
    super(`Embedded agent aggregate was not found: ${agentId}`);
    this.name = "InMemoryAgentAggregateNotFoundError";
  }
}

export class InMemoryAgentIncarnationMismatchError extends Error {
  readonly code = "embedded_agent_incarnation_mismatch";

  constructor(readonly agentId: string) {
    super(`Embedded agent incarnation changed during mutation: ${agentId}`);
    this.name = "InMemoryAgentIncarnationMismatchError";
  }
}

export class InMemoryAgentStore extends BaseAgentStore {
  private settings = new Map<string, AgentSettings>();
  private metadata = new Map<string, AgentMetadata>();
  private incarnations = new Map<string, symbol>();
  private connections = new Map<string, StoredConnection>();
  private connectionsAll = new Set<string>();
  private connectionsByAgent = new Map<string, Set<string>>();
  private channelBindings = new Map<string, ChannelBinding>();
  private channelBindingIndex = new Map<string, Set<string>>();
  private grants = new Map<
    string,
    { expiresAt: number | null; grantedAt: number; denied?: boolean }
  >();
  private userAgents = new Map<string, Set<string>>();

  // ── Settings primitives ───────────────────────────────────────────

  protected async readSettings(agentId: string): Promise<AgentSettings | null> {
    return this.settings.get(agentId) ?? null;
  }

  protected async writeSettings(
    agentId: string,
    settings: AgentSettings
  ): Promise<void> {
    this.assertLiveAgent(agentId);
    this.settings.set(agentId, settings);
  }

  protected async deleteSettingsRaw(agentId: string): Promise<void> {
    this.settings.delete(agentId);
  }

  protected async hasSettingsRaw(agentId: string): Promise<boolean> {
    return this.settings.has(agentId);
  }

  // ── Metadata primitives ───────────────────────────────────────────

  protected async readMetadata(agentId: string): Promise<AgentMetadata | null> {
    return this.metadata.get(agentId) ?? null;
  }

  async saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void> {
    if (!this.metadata.has(agentId)) {
      this.incarnations.set(agentId, Symbol(agentId));
    }
    this.metadata.set(agentId, metadata);
    if (!this.settings.has(agentId)) {
      this.settings.set(agentId, { updatedAt: Date.now() });
    }
  }

  async updateMetadata(
    agentId: string,
    updates: Partial<AgentMetadata>
  ): Promise<void> {
    const existing = this.metadata.get(agentId);
    if (!existing) return;
    await this.saveMetadata(agentId, { ...existing, ...updates });
  }

  override async updateSettings(
    agentId: string,
    updates: Partial<AgentSettings>
  ): Promise<void> {
    const incarnation = this.captureLiveIncarnation(agentId);
    const existing = await this.readSettings(agentId);
    this.assertCurrentIncarnation(agentId, incarnation);
    await this.writeSettings(agentId, {
      ...(existing || {}),
      ...updates,
      updatedAt: Date.now(),
    } as AgentSettings);
  }

  protected async deleteMetadataRaw(agentId: string): Promise<void> {
    // Intentionally no await: once aggregate deletion starts, every map/index
    // is cleared in one JS turn. Child writers validate metadata synchronously,
    // so they either commit before this turn or reject after it.
    const connectionIds = Array.from(this.connectionsByAgent.get(agentId) ?? []);
    for (const connectionId of connectionIds) {
      if (this.connections.get(connectionId)?.agentId === agentId) {
        this.deleteConnectionNow(connectionId);
      }
    }
    this.connectionsByAgent.delete(agentId);

    const bindingKeys = Array.from(this.channelBindingIndex.get(agentId) ?? []);
    for (const key of bindingKeys) {
      if (this.channelBindings.get(key)?.agentId === agentId) {
        this.channelBindings.delete(key);
      }
    }
    this.channelBindingIndex.delete(agentId);

    const grantPrefix = `${agentId}:`;
    for (const key of this.grants.keys()) {
      if (key.startsWith(grantPrefix)) this.grants.delete(key);
    }
    for (const [key, agentIds] of this.userAgents) {
      agentIds.delete(agentId);
      if (agentIds.size === 0) this.userAgents.delete(key);
    }

    this.metadata.delete(agentId);
    this.settings.delete(agentId);
    this.incarnations.delete(agentId);
  }

  protected async hasMetadataRaw(agentId: string): Promise<boolean> {
    return this.metadata.has(agentId);
  }

  protected async listAllMetadata(): Promise<AgentMetadata[]> {
    return Array.from(this.metadata.values());
  }

  // ── Connection primitives ─────────────────────────────────────────

  protected async readConnection(
    connectionId: string
  ): Promise<StoredConnection | null> {
    return this.connections.get(connectionId) ?? null;
  }

  protected async writeConnection(connection: StoredConnection): Promise<void> {
    if (connection.agentId) this.assertLiveAgent(connection.agentId);
    const previous = this.connections.get(connection.id);
    if (previous?.agentId && previous.agentId !== connection.agentId) {
      const previousAgentConnections = this.connectionsByAgent.get(
        previous.agentId
      );
      previousAgentConnections?.delete(connection.id);
      if (previousAgentConnections?.size === 0) {
        this.connectionsByAgent.delete(previous.agentId);
      }
    }
    this.connections.set(connection.id, connection);
    this.connectionsAll.add(connection.id);
    if (connection.agentId) {
      getOrCreateSet(this.connectionsByAgent, connection.agentId).add(
        connection.id
      );
    }
  }

  override async updateConnection(
    connectionId: string,
    updates: Partial<StoredConnection>
  ): Promise<void> {
    const ownerAtStart = this.connections.get(connectionId)?.agentId;
    const incarnation = ownerAtStart
      ? this.captureLiveIncarnation(ownerAtStart)
      : null;
    const existing = await this.readConnection(connectionId);
    if (!existing) return;
    if (ownerAtStart && incarnation) {
      this.assertCurrentIncarnation(ownerAtStart, incarnation);
    }
    await this.saveConnection({
      ...existing,
      ...updates,
      id: connectionId,
      updatedAt: Date.now(),
    });
  }

  protected async deleteConnectionRaw(connectionId: string): Promise<void> {
    this.deleteConnectionNow(connectionId);
  }

  private deleteConnectionNow(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    this.connectionsAll.delete(connectionId);
    if (conn?.agentId) {
      const set = this.connectionsByAgent.get(conn.agentId);
      if (set) {
        set.delete(connectionId);
        if (set.size === 0)
          this.connectionsByAgent.delete(conn.agentId);
      }
    }
  }

  protected async listConnectionsByAgent(
    agentId?: string
  ): Promise<StoredConnection[]> {
    const ids: Iterable<string> = agentId
      ? (this.connectionsByAgent.get(agentId) ?? [])
      : this.connectionsAll;

    const connections: StoredConnection[] = [];
    for (const id of ids) {
      const conn = this.connections.get(id);
      if (conn) connections.push(conn);
    }
    return connections;
  }

  // ── Grants ──────────────────────────────────────────────────────

  private grantKey(agentId: string, pattern: string): string {
    const normalizedPattern = pattern.startsWith("/")
      ? pattern
      : normalizeDomainPattern(pattern);

    return buildKey([agentId, normalizedPattern]);
  }

  private getValidGrant(
    agentId: string,
    pattern: string
  ): { expiresAt: number | null; grantedAt: number; denied?: boolean } | null {
    const key = this.grantKey(agentId, pattern);
    const entry = this.grants.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.grants.delete(key);
      return null;
    }
    return entry;
  }

  async grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void> {
    this.assertLiveAgent(agentId);
    this.grants.set(this.grantKey(agentId, pattern), {
      expiresAt,
      grantedAt: Date.now(),
      ...(denied && { denied: true }),
    });
  }

  async hasGrant(agentId: string, pattern: string): Promise<boolean> {
    // Exact match
    const exact = this.getValidGrant(agentId, pattern);
    if (exact) return !exact.denied;

    // MCP wildcard: /mcp/gmail/tools/send_email -> /mcp/gmail/tools/*
    if (pattern.startsWith("/mcp/")) {
      const lastSlash = pattern.lastIndexOf("/");
      if (lastSlash > 0) {
        const wildcard = `${pattern.substring(0, lastSlash)}/*`;
        const entry = this.getValidGrant(agentId, wildcard);
        if (entry) return !entry.denied;
      }
    }

    // Domain wildcard: sub.example.com -> .example.com
    if (!pattern.startsWith("/")) {
      const parts = pattern.split(".");
      if (parts.length > 2) {
        const wildcard = `.${parts.slice(1).join(".")}`;
        const entry = this.getValidGrant(agentId, wildcard);
        if (entry) return !entry.denied;
      }
    }

    return false;
  }

  async isDenied(agentId: string, pattern: string): Promise<boolean> {
    const entry = this.getValidGrant(agentId, pattern);
    if (!entry) return false;
    return entry.denied === true;
  }

  async listGrants(agentId: string): Promise<Grant[]> {
    const prefix = `${agentId}:`;
    const grants: Grant[] = [];
    for (const [key, entry] of this.grants) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        this.grants.delete(key);
        continue;
      }
      const pattern = key.substring(prefix.length);
      grants.push({
        pattern,
        kind: inferGrantKind(pattern),
        expiresAt: entry.expiresAt,
        grantedAt: entry.grantedAt,
        ...(entry.denied && { denied: true }),
      });
    }
    return grants;
  }

  async revokeGrant(agentId: string, pattern: string): Promise<void> {
    this.grants.delete(this.grantKey(agentId, pattern));
  }

  // ── User-Agent Associations ─────────────────────────────────────

  private userKey(platform: string, userId: string): string {
    return buildKey([platform, userId]);
  }

  async addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    this.assertLiveAgent(agentId);
    getOrCreateSet(this.userAgents, this.userKey(platform, userId)).add(
      agentId
    );
  }

  async removeUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const key = this.userKey(platform, userId);
    const set = this.userAgents.get(key);
    if (set) {
      set.delete(agentId);
      if (set.size === 0) this.userAgents.delete(key);
    }
  }

  async listUserAgents(platform: string, userId: string): Promise<string[]> {
    const set = this.userAgents.get(this.userKey(platform, userId));
    return set ? Array.from(set) : [];
  }

  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    const set = this.userAgents.get(this.userKey(platform, userId));
    return set ? set.has(agentId) : false;
  }

  // ── Channel Bindings ────────────────────────────────────────────

  private channelBindingKey(
    platform: string,
    channelId: string,
    teamId?: string
  ): string {
    return teamId
      ? buildKey([platform, channelId, teamId])
      : buildKey([platform, channelId]);
  }

  async getChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    return (
      this.channelBindings.get(
        this.channelBindingKey(platform, channelId, teamId)
      ) ?? null
    );
  }

  async createChannelBinding(binding: ChannelBinding): Promise<void> {
    this.assertLiveAgent(binding.agentId);
    const key = this.channelBindingKey(
      binding.platform,
      binding.channelId,
      binding.teamId
    );
    const previous = this.channelBindings.get(key);
    if (previous && previous.agentId !== binding.agentId) {
      const previousAgentBindings = this.channelBindingIndex.get(
        previous.agentId
      );
      previousAgentBindings?.delete(key);
      if (previousAgentBindings?.size === 0) {
        this.channelBindingIndex.delete(previous.agentId);
      }
    }
    this.channelBindings.set(key, binding);
    getOrCreateSet(this.channelBindingIndex, binding.agentId).add(key);
  }

  async deleteChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<void> {
    const key = this.channelBindingKey(platform, channelId, teamId);
    const binding = this.channelBindings.get(key);
    if (binding) {
      const set = this.channelBindingIndex.get(binding.agentId);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.channelBindingIndex.delete(binding.agentId);
      }
    }
    this.channelBindings.delete(key);
  }

  async listChannelBindings(agentId: string): Promise<ChannelBinding[]> {
    const keys = this.channelBindingIndex.get(agentId);
    if (!keys) return [];
    const bindings: ChannelBinding[] = [];
    for (const key of keys) {
      const binding = this.channelBindings.get(key);
      if (binding) bindings.push(binding);
    }
    return bindings;
  }

  async deleteAllChannelBindings(agentId: string): Promise<number> {
    const keys = this.channelBindingIndex.get(agentId);
    if (!keys || keys.size === 0) return 0;
    const count = keys.size;
    for (const key of keys) {
      this.channelBindings.delete(key);
    }
    this.channelBindingIndex.delete(agentId);
    return count;
  }

  private assertLiveAgent(agentId: string): void {
    if (!this.metadata.has(agentId)) {
      throw new InMemoryAgentAggregateNotFoundError(agentId);
    }
  }

  private captureLiveIncarnation(agentId: string): symbol {
    this.assertLiveAgent(agentId);
    const incarnation = this.incarnations.get(agentId);
    if (!incarnation) throw new InMemoryAgentAggregateNotFoundError(agentId);
    return incarnation;
  }

  private assertCurrentIncarnation(agentId: string, expected: symbol): void {
    if (this.incarnations.get(agentId) !== expected) {
      throw new InMemoryAgentIncarnationMismatchError(agentId);
    }
  }
}
