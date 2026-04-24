import { beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { GrantStore } from "../permissions/grant-store.js";

describe("GrantStore", () => {
  let redis: MockRedisClient;
  let store: GrantStore;

  beforeEach(() => {
    redis = new MockRedisClient();
    store = new GrantStore(redis);
  });

  describe("grant", () => {
    test("stores grant without TTL when expiresAt is null", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      const raw = await redis.get("grant:agent-1:api.openai.com");
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.expiresAt).toBeNull();
      expect(parsed.grantedAt).toBeGreaterThan(0);
    });

    test("stores grant with TTL when expiresAt is set", async () => {
      const future = Date.now() + 60_000;
      await store.grant("agent-1", "api.openai.com", future);
      const raw = await redis.get("grant:agent-1:api.openai.com");
      expect(raw).not.toBeNull();
    });

    test("stores denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      const raw = await redis.get("grant:agent-1:evil.com");
      const parsed = JSON.parse(raw!);
      expect(parsed.denied).toBe(true);
    });

    test("preserves MCP path casing when storing grants", async () => {
      await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
      const raw = await redis.get("grant:agent-1:/mcp/Gmail/tools/SendEmail");
      expect(raw).not.toBeNull();
    });
  });

  describe("hasGrant", () => {
    test("returns true for existing grant", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
    });

    test("returns false for missing grant", async () => {
      expect(await store.hasGrant("agent-1", "unknown.com")).toBe(false);
    });

    test("returns false for denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      expect(await store.hasGrant("agent-1", "evil.com")).toBe(false);
    });

    test("matches MCP wildcard pattern", async () => {
      await store.grant("agent-1", "/mcp/gmail/tools/*", null);
      expect(
        await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
      ).toBe(true);
    });

    test("matches exact MCP path with original casing", async () => {
      await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
      expect(
        await store.hasGrant("agent-1", "/mcp/Gmail/tools/SendEmail")
      ).toBe(true);
    });

    test("MCP wildcard denied blocks access", async () => {
      await store.grant("agent-1", "/mcp/gmail/tools/*", null, true);
      expect(
        await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
      ).toBe(false);
    });

    test("matches domain wildcard pattern", async () => {
      await store.grant("agent-1", "*.example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("matches leading-dot domain wildcard pattern", async () => {
      await store.grant("agent-1", ".example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("domain wildcard does not match two-part domains", async () => {
      await store.grant("agent-1", "*.example.com", null);
      // "example.com" has only 2 parts, so wildcard check is skipped
      expect(await store.hasGrant("agent-1", "example.com")).toBe(false);
    });

    test("domain wildcard denied blocks access", async () => {
      await store.grant("agent-1", "*.evil.com", null, true);
      expect(await store.hasGrant("agent-1", "sub.evil.com")).toBe(false);
    });

    test("exact match takes precedence over wildcards", async () => {
      await store.grant("agent-1", "api.example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("non-MCP non-domain path returns false", async () => {
      // Pattern starting with "/" but not "/mcp/" doesn't get wildcard check
      expect(await store.hasGrant("agent-1", "/some/other/path")).toBe(false);
    });
  });

  describe("isDenied", () => {
    test("returns true for denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      expect(await store.isDenied("agent-1", "evil.com")).toBe(true);
    });

    test("matches denied leading-dot wildcard pattern", async () => {
      await store.grant("agent-1", ".evil.com", null, true);
      expect(await store.isDenied("agent-1", ".evil.com")).toBe(true);
      expect(await store.hasGrant("agent-1", "sub.evil.com")).toBe(false);
    });

    test("returns false for allowed grant", async () => {
      await store.grant("agent-1", "good.com", null);
      expect(await store.isDenied("agent-1", "good.com")).toBe(false);
    });

    test("returns false for missing grant", async () => {
      expect(await store.isDenied("agent-1", "unknown.com")).toBe(false);
    });
  });

  describe("revoke", () => {
    test("removes grant", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
      await store.revoke("agent-1", "api.openai.com");
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(false);
    });

    test("removes normalized wildcard grant variants", async () => {
      await store.grant("agent-1", "*.github.com", null);
      expect(await store.hasGrant("agent-1", "api.github.com")).toBe(true);
      await store.revoke("agent-1", ".github.com");
      expect(await store.hasGrant("agent-1", "api.github.com")).toBe(false);
    });
  });

  describe("listGrants", () => {
    test("returns empty array when no grants", async () => {
      // MockRedisClient doesn't have scan, so we need to add it for this test
      // For now, test that the method handles missing scan gracefully
      (redis as any).scan = async () => ["0", []];
      (redis as any).mget = async () => [];
      const grants = await store.listGrants("agent-1");
      expect(grants).toEqual([]);
    });

    test("lists grants via SCAN", async () => {
      // Simulate scan returning keys
      const grantValue = JSON.stringify({
        expiresAt: null,
        grantedAt: 1000,
      });
      (redis as any).scan = async () => [
        "0",
        ["grant:agent-1:api.openai.com", "grant:agent-1:*.github.com"],
      ];
      (redis as any).mget = async () => [grantValue, grantValue];

      const grants = await store.listGrants("agent-1");
      expect(grants).toHaveLength(2);
      expect(grants[0]!.pattern).toBe("api.openai.com");
      expect(grants[1]!.pattern).toBe("*.github.com");
    });
  });
});
