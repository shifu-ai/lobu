import { createLogger } from "@lobu/core";
import { getOrgId } from "../../../lobu/stores/org-context.js";

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
  provenance?: {
    upstreamOrigin: string;
    configSource: "global" | "agent" | "derived";
    configDigest: string;
  };
}

/**
 * In-memory MCP tool cache. Per-gateway-process; a miss recomputes by hitting
 * the MCP server's `tools/list` endpoint. The 5-minute TTL is short enough
 * that a gateway restart (or a multi-replica fan-out) doesn't serve stale
 * tool metadata. No cross-replica coherence problem since every replica
 * probes upstream itself on miss.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;
const CACHE_KEY_PREFIX = "mcp:tools:v2:";

interface CacheEntry {
  info: CachedMcpServer;
  expiresAt: number;
}

export class McpToolCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(mcpId: string, agentId?: string): McpTool[] | null {
    const info = this.getServerInfo(mcpId, agentId);
    return info ? info.tools : null;
  }

  set(mcpId: string, tools: McpTool[], agentId?: string): void {
    this.setServerInfo(mcpId, { tools }, agentId);
  }

  delete(mcpId: string, agentId?: string): void {
    const orgId = getOrgId();
    for (const key of this.entries.keys()) {
      const parsed = this.parseKey(key);
      if (!parsed) continue;
      if (parsed.orgId !== orgId) continue;
      if (agentId && parsed.agentId !== agentId) continue;
      if (this.matchesMcpIdOrFilterVariant(parsed.mcpId, mcpId)) {
        this.entries.delete(key);
      }
    }
  }

  getServerInfo(mcpId: string, agentId?: string): CachedMcpServer | null {
    const key = this.buildKey(mcpId, agentId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    // Map iteration order is used as the LRU order. Move cache hits to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.info;
  }

  setServerInfo(mcpId: string, info: CachedMcpServer, agentId?: string): void {
    const key = this.buildKey(mcpId, agentId);
    try {
      const now = Date.now();
      this.sweepExpired(now);
      this.entries.delete(key);
      this.entries.set(key, {
        info,
        expiresAt: now + CACHE_TTL_MS,
      });
      while (this.entries.size > MAX_CACHE_ENTRIES) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
    } catch (error) {
      logger.error("Failed to write tool cache", { key, error });
    }
  }

  getInstructions(mcpId: string, agentId?: string): string | undefined {
    const info = this.getServerInfo(mcpId, agentId);
    return info?.instructions;
  }

  /**
   * Cache keys are org-scoped. The McpToolCache is a process-wide singleton
   * shared by every org, but agentId is NOT globally unique (agents PK is
   * (organization_id, id) and ids are human slugs), so two orgs with the same
   * agentId+mcpId would otherwise collide — letting org A's tool annotations
   * auto-approve org B's destructive tool call. Every get/set runs inside
   * `runWithOrganizationContext`, so we derive the org from that context
   * rather than threading it through every signature (which could be forgotten
   * at a call site).
   */
  private buildKey(mcpId: string, agentId?: string): string {
    const orgId = getOrgId();
    const orgPart = encodeURIComponent(orgId);
    const agentPart = encodeURIComponent(agentId ?? "");
    const mcpPart = encodeURIComponent(mcpId);
    return `${CACHE_KEY_PREFIX}${orgPart}:${agentPart}:${mcpPart}`;
  }

  private parseKey(
    key: string,
  ): { orgId: string; agentId?: string; mcpId: string } | null {
    if (!key.startsWith(CACHE_KEY_PREFIX)) return null;
    const rest = key.slice(CACHE_KEY_PREFIX.length);
    const firstSeparator = rest.indexOf(":");
    if (firstSeparator < 0) return null;
    const secondSeparator = rest.indexOf(":", firstSeparator + 1);
    if (secondSeparator < 0) return null;
    const orgPart = rest.slice(0, firstSeparator);
    const agentPart = rest.slice(firstSeparator + 1, secondSeparator);
    const mcpPart = rest.slice(secondSeparator + 1);
    if (!orgPart) return null;
    if (!mcpPart) return null;
    return {
      orgId: decodeURIComponent(orgPart),
      agentId: agentPart ? decodeURIComponent(agentPart) : undefined,
      mcpId: decodeURIComponent(mcpPart),
    };
  }

  private matchesMcpIdOrFilterVariant(
    candidate: string,
    mcpId: string,
  ): boolean {
    return (
      candidate === mcpId ||
      candidate.startsWith(`${mcpId}:config:`) ||
      candidate.startsWith(`${mcpId}:toolFilter:`)
    );
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
