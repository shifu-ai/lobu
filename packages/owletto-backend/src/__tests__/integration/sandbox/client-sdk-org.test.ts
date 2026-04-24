/**
 * Integration tests for `ClientSDK.org()` — the cross-org accessor.
 *
 * Exercises membership resolution against the real `organization`/`member`
 * tables, LRU caching behavior, and the access-denied path for non-members
 * on private orgs. The handler delegation itself is covered by the existing
 * per-tool integration tests; these tests focus on the context-swap and
 * auth-reverification semantics introduced by PR-1.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  buildClientSDK,
  MembershipCache,
  OrgNotFoundError,
  resolveOrgMembership,
} from "../../../sandbox/client-sdk";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

const testEnv: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
};

describe("ClientSDK.org() accessor", () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgPublic: Awaited<ReturnType<typeof createTestOrganization>>;
  let user1: Awaited<ReturnType<typeof createTestUser>>;
  let user2: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgA = await createTestOrganization({ name: "Org A", slug: "org-a-sdk" });
    orgB = await createTestOrganization({ name: "Org B", slug: "org-b-sdk" });
    orgPublic = await createTestOrganization({
      name: "Org Public",
      slug: "org-public-sdk",
      visibility: "public",
    });
    user1 = await createTestUser({ email: "user1-sdk@test.example.com" });
    user2 = await createTestUser({ email: "user2-sdk@test.example.com" });
    await addUserToOrganization(user1.id, orgA.id, "owner");
    await addUserToOrganization(user2.id, orgB.id, "admin");
  });

  function buildCtx(userId: string, orgId: string): ToolContext {
    return {
      organizationId: orgId,
      userId,
      memberRole: "owner",
      isAuthenticated: true,
    };
  }

  describe("resolveOrgMembership", () => {
    let cache: MembershipCache;
    beforeEach(() => {
      cache = new MembershipCache(60_000);
    });

    it("resolves by slug for a member", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgA.slug, ctx, cache);
      expect(record.orgId).toBe(orgA.id);
      expect(record.role).toBe("owner");
      expect(record.visibility).toBe("private");
    });

    it("resolves by id for a member", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgA.id, ctx, cache);
      expect(record.slug).toBe(orgA.slug);
    });

    it("throws AccessDenied on private org the user is not a member of", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      await expect(
        resolveOrgMembership(orgB.slug, ctx, cache)
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("returns record with role=null on public org for non-members", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgPublic.slug, ctx, cache);
      expect(record.visibility).toBe("public");
      expect(record.role).toBeNull();
    });

    it("throws OrgNotFound for an unknown slug", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      await expect(
        resolveOrgMembership("does-not-exist-xyz", ctx, cache)
      ).rejects.toBeInstanceOf(OrgNotFoundError);
    });

    it("caches subsequent lookups for both slug and id", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      await resolveOrgMembership(orgA.slug, ctx, cache);
      // After first lookup, cache should have entries keyed by both id and slug.
      expect(cache.get(user1.id, orgA.slug)).not.toBeNull();
      expect(cache.get(user1.id, orgA.id)).not.toBeNull();
    });
  });

  describe("buildClientSDK", () => {
    it("exposes every namespace", () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      expect(sdk.entities).toBeDefined();
      expect(sdk.entitySchema).toBeDefined();
      expect(sdk.connections).toBeDefined();
      expect(sdk.feeds).toBeDefined();
      expect(sdk.authProfiles).toBeDefined();
      expect(sdk.operations).toBeDefined();
      expect(sdk.watchers).toBeDefined();
      expect(sdk.classifiers).toBeDefined();
      expect(sdk.viewTemplates).toBeDefined();
      expect(sdk.knowledge).toBeDefined();
      expect(sdk.organizations).toBeDefined();
      expect(sdk.query).toBeInstanceOf(Function);
      expect(sdk.log).toBeInstanceOf(Function);
      expect(sdk.org).toBeInstanceOf(Function);
    });

    it(".org() returns a fresh SDK for another org the caller belongs to", async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      expect(sdkB).toBeDefined();
      expect(sdkB).not.toBe(sdk);
      expect(sdkB.org).toBeInstanceOf(Function);
      // Clean up so later tests see user1 back to orgA-only where applicable.
      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;
    });

    it(".org() throws AccessDenied on a non-member private org", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        AccessDeniedError
      );
    });

    it(".org() returns an SDK with memberRole=null for public orgs non-members", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const cache = new MembershipCache(60_000);
      const record = await resolveOrgMembership(orgPublic.slug, ctx, cache);
      expect(record.role).toBeNull();
      // The SDK itself is built from ctx, so the org() call returns a valid
      // ClientSDK — per-handler auth checks reject writes downstream.
      const sdk = buildClientSDK(ctx, testEnv, { membershipCache: cache });
      const sdkPub = await sdk.org(orgPublic.slug);
      expect(sdkPub).toBeDefined();
    });

    it("chained .org() re-validates against the original user", async () => {
      // Give user1 access to both orgA and orgB, then hop A → B → A.
      await addUserToOrganization(user1.id, orgB.id, "member");
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      const sdkBackToA = await sdkB.org(orgA.slug);
      expect(sdkBackToA).toBeDefined();
      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;
    });

    it("membership cache shortcircuits a repeated .org() call", async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
      const ctx = buildCtx(user1.id, orgA.id);
      const cache = new MembershipCache(60_000);
      const sdk = buildClientSDK(ctx, testEnv, { membershipCache: cache });
      await sdk.org(orgB.slug);
      expect(cache.size()).toBeGreaterThan(0);
      await sdk.org(orgB.slug); // second call hits cache; no new entries
      const sizeAfter = cache.size();
      await sdk.org(orgB.id); // id lookup, already cached under id during first call
      expect(cache.size()).toBe(sizeAfter);

      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;
    });

    it("revocation is detected after cache TTL expires", async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
      const ctx = buildCtx(user1.id, orgA.id);
      const cache = new MembershipCache(5); // 5ms TTL
      const sdk = buildClientSDK(ctx, testEnv, { membershipCache: cache });
      await sdk.org(orgB.slug);

      // Revoke membership.
      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;

      // Wait past TTL, then expect AccessDenied.
      await new Promise((r) => setTimeout(r, 15));
      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        AccessDeniedError
      );
    });
  });

  describe("non-member isolation", () => {
    it("user2 cannot access orgA", async () => {
      const ctx = buildCtx(user2.id, orgB.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgA.slug)).rejects.toBeInstanceOf(
        AccessDeniedError
      );
    });
  });
});
