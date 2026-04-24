import { describe, expect, it } from "bun:test";
import { MembershipCache } from "../../../sandbox/membership-cache";

describe("MembershipCache", () => {
  it("stores and retrieves a record by any of its keys", () => {
    const cache = new MembershipCache(60_000);
    cache.set("user-1", ["org_abc", "buremba"], {
      orgId: "org_abc",
      slug: "buremba",
      role: "admin",
      visibility: "private",
    });
    const byId = cache.get("user-1", "org_abc");
    const bySlug = cache.get("user-1", "buremba");
    expect(byId).not.toBeNull();
    expect(bySlug).not.toBeNull();
    expect(byId?.slug).toBe("buremba");
    expect(bySlug?.orgId).toBe("org_abc");
  });

  it("is case-insensitive on the key", () => {
    const cache = new MembershipCache(60_000);
    cache.set("u", ["BuRemba"], {
      orgId: "x",
      slug: "buremba",
      role: "member",
      visibility: "private",
    });
    expect(cache.get("u", "buremba")).not.toBeNull();
    expect(cache.get("u", "BUREMBA")).not.toBeNull();
  });

  it("scopes entries by userId", () => {
    const cache = new MembershipCache(60_000);
    cache.set("alice", ["org1"], {
      orgId: "org1",
      slug: "org1",
      role: "admin",
      visibility: "private",
    });
    expect(cache.get("alice", "org1")).not.toBeNull();
    expect(cache.get("bob", "org1")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    const cache = new MembershipCache(5); // 5ms
    cache.set("u", ["x"], {
      orgId: "x",
      slug: "x",
      role: "member",
      visibility: "private",
    });
    expect(cache.get("u", "x")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get("u", "x")).toBeNull();
  });

  it("evicts oldest entries past capacity", () => {
    const cache = new MembershipCache(60_000);
    for (let i = 0; i < 200; i++) {
      cache.set(`u-${i}`, [`org-${i}`], {
        orgId: `org-${i}`,
        slug: `org-${i}`,
        role: "member",
        visibility: "private",
      });
    }
    // Cap is 128; first entries should be gone.
    expect(cache.size()).toBeLessThanOrEqual(128);
    expect(cache.get("u-0", "org-0")).toBeNull();
    expect(cache.get("u-199", "org-199")).not.toBeNull();
  });

  it("refreshes LRU order on get", () => {
    const cache = new MembershipCache(60_000);
    for (let i = 0; i < 128; i++) {
      cache.set(`u-${i}`, [`org-${i}`], {
        orgId: `org-${i}`,
        slug: `org-${i}`,
        role: "member",
        visibility: "private",
      });
    }
    // Touch the oldest.
    expect(cache.get("u-0", "org-0")).not.toBeNull();
    // Add a new one — oldest (u-1) should be evicted, not u-0.
    cache.set("u-fresh", ["org-fresh"], {
      orgId: "org-fresh",
      slug: "org-fresh",
      role: "member",
      visibility: "private",
    });
    expect(cache.get("u-0", "org-0")).not.toBeNull();
    expect(cache.get("u-1", "org-1")).toBeNull();
  });

  it("clears all entries", () => {
    const cache = new MembershipCache(60_000);
    cache.set("u", ["a"], {
      orgId: "a",
      slug: "a",
      role: "member",
      visibility: "private",
    });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("u", "a")).toBeNull();
  });
});
