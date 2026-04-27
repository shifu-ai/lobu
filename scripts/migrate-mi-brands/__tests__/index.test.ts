import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuditLog,
  type CreateEntityInput,
  type CreateLinkInput,
  createAuditLog,
  type OrgClient,
  type OwlettoEntity,
  type OwlettoRelationship,
  parseRootArgs,
  readAuditLog,
  type UpdateEntityInput,
} from "../lib.ts";
import { type MigrationDeps, runMigration } from "../index.ts";

// ── parseRootArgs ──────────────────────────────────────────────────────

describe("parseRootArgs", () => {
  test("default is dry-run", () => {
    const a = parseRootArgs([]);
    expect(a.apply).toBe(false);
    expect(a.dryRun).toBe(true);
    expect(a.matchOnly).toBe("both");
    expect(a.threshold).toBe(0.92);
    expect(a.sourceOrg).toBe("market-intelligence");
    expect(a.targetOrg).toBe("market");
    expect(a.limit).toBeUndefined();
  });

  test("--apply flips to live mode", () => {
    const a = parseRootArgs(["--apply"]);
    expect(a.apply).toBe(true);
    expect(a.dryRun).toBe(false);
  });

  test("--dry-run beats --apply when both passed", () => {
    const a = parseRootArgs(["--apply", "--dry-run"]);
    expect(a.apply).toBe(false);
    expect(a.dryRun).toBe(true);
  });

  test("rejects bad --limit values", () => {
    expect(() => parseRootArgs(["--limit=0"])).toThrow();
    expect(() => parseRootArgs(["--limit=-5"])).toThrow();
    expect(() => parseRootArgs(["--limit=foo"])).toThrow();
  });

  test("rejects unknown flags so typos don't silently pass", () => {
    expect(() => parseRootArgs(["--apply-now"])).toThrow();
  });

  test("rejects malformed source/target org slugs", () => {
    expect(() => parseRootArgs(["--source-org=Bad Slug"])).toThrow();
    expect(() => parseRootArgs(["--target-org=BAD"])).toThrow();
  });

  test("--limit / --threshold / --match-only", () => {
    const a = parseRootArgs([
      "--limit=5",
      "--threshold=0.9",
      "--match-only=domain",
    ]);
    expect(a.limit).toBe(5);
    expect(a.threshold).toBe(0.9);
    expect(a.matchOnly).toBe("domain");
  });

  test("rejects bad threshold", () => {
    expect(() => parseRootArgs(["--threshold=2"])).toThrow();
    expect(() => parseRootArgs(["--threshold=foo"])).toThrow();
  });

  test("rejects bad match-only", () => {
    expect(() => parseRootArgs(["--match-only=fancy"])).toThrow();
  });

  test("--source-org / --target-org overrides", () => {
    const a = parseRootArgs(["--source-org=mi", "--target-org=m"]);
    expect(a.sourceOrg).toBe("mi");
    expect(a.targetOrg).toBe("m");
  });
});

// ── Mock OrgClient ─────────────────────────────────────────────────────

interface MockOrg {
  slug: string;
  entities: Map<number, OwlettoEntity>;
  relationships: Map<number, OwlettoRelationship>;
  /** Per-call audit. */
  creates: CreateEntityInput[];
  updates: UpdateEntityInput[];
  links: CreateLinkInput[];
  unlinks: number[];
  nextEntityId: number;
  nextRelationshipId: number;
}

function makeMockOrg(slug: string, initial: OwlettoEntity[]): MockOrg {
  return {
    slug,
    entities: new Map(initial.map((e) => [e.id, structuredClone(e)])),
    relationships: new Map(),
    creates: [],
    updates: [],
    links: [],
    unlinks: [],
    nextEntityId: Math.max(0, ...initial.map((e) => e.id)) + 1,
    nextRelationshipId: 1000,
  };
}

function makeOrgClient(state: MockOrg): OrgClient {
  return {
    orgSlug: state.slug,
    async listEntities(entity_type) {
      return [...state.entities.values()].filter(
        (e) => e.entity_type === entity_type
      );
    },
    async getEntity(entity_id) {
      return state.entities.get(entity_id) ?? null;
    },
    async createEntity(input) {
      state.creates.push(structuredClone(input));
      const ent: OwlettoEntity = {
        id: state.nextEntityId++,
        name: input.name,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        entity_type: input.entity_type,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      state.entities.set(ent.id, ent);
      return ent;
    },
    async updateEntity(input) {
      state.updates.push(structuredClone(input));
      const cur = state.entities.get(input.entity_id);
      if (!cur) throw new Error(`unknown entity ${input.entity_id}`);
      if (input.name !== undefined) cur.name = input.name;
      if (input.slug !== undefined) cur.slug = input.slug;
      if (input.metadata !== undefined) cur.metadata = input.metadata;
      return cur;
    },
    async listLinks(args) {
      return [...state.relationships.values()].filter((r) => {
        if (
          args.relationship_type_slug &&
          r.relationship_type_slug !== args.relationship_type_slug
        ) {
          return false;
        }
        return (
          r.from_entity_id === args.entity_id ||
          r.to_entity_id === args.entity_id
        );
      });
    },
    async createLink(input) {
      state.links.push(structuredClone(input));
      const r: OwlettoRelationship = {
        id: state.nextRelationshipId++,
        from_entity_id: input.from_entity_id,
        to_entity_id: input.to_entity_id,
        relationship_type_slug: input.relationship_type_slug,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.confidence !== undefined
          ? { confidence: input.confidence }
          : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      };
      state.relationships.set(r.id, r);
      return r;
    },
    async unlink(relationship_id) {
      state.unlinks.push(relationship_id);
      state.relationships.delete(relationship_id);
    },
  };
}

function silentAudit(dir: string): AuditLog {
  return createAuditLog({ dryRun: true, dir, filename: "test-run.jsonl" });
}

// ── Synthetic fixture (5 brands × 5 companies) ─────────────────────────

/**
 * The canonical fixture used by every end-to-end test:
 *
 * brand 1 Acme           → company 100 Acme Corporation     (domain match)
 * brand 2 Globex Indust. → company 101 Globex               (fuzzy at threshold 0.85)
 * brand 3 DupeCo         → companies 102 + 103              (ambiguous, same domain)
 * brand 4 FreshBrand     → no match                          (create new)
 * brand 5 Initech Sol.   → company 104 Initech               (fuzzy at threshold 0.85)
 *
 * Plus a `mentions` link from brand 1 → content 901 that the
 * mention-retarget pass should rewrite to point at company 100.
 */
function buildFixture() {
  const source = makeMockOrg("market-intelligence", [
    {
      id: 1,
      name: "Acme",
      slug: "acme-mi",
      entity_type: "brand",
      metadata: {
        primary_domain: "https://www.acme.com",
        logo_url: "https://acme.com/logo.png",
        tagline: "We build things",
        social_handles: { twitter: "@acme" },
      },
    },
    {
      id: 2,
      name: "Globex Industries",
      slug: "globex-mi",
      entity_type: "brand",
      metadata: {
        positioning: "industrial automation",
      },
    },
    {
      id: 3,
      name: "DupeCo",
      slug: "dupeco-mi",
      entity_type: "brand",
      metadata: {
        homepage_url: "https://dupe.example",
        tagline: "Should be ambiguous",
      },
    },
    {
      id: 4,
      name: "FreshBrand",
      slug: "freshbrand-mi",
      entity_type: "brand",
      metadata: {
        primary_domain: "https://freshbrand.io",
        tagline: "All new",
        social_handles: { linkedin: "company/freshbrand" },
      },
    },
    {
      id: 5,
      name: "Initech Solutions",
      slug: "initech-mi",
      entity_type: "brand",
      metadata: {
        tagline: "Office software",
      },
    },
  ]);

  // Mention from brand 1 → content 901 — should re-point at company 100.
  source.entities.set(901, {
    id: 901,
    name: "TechCrunch article",
    entity_type: "content",
    metadata: {},
  });
  source.relationships.set(2001, {
    id: 2001,
    from_entity_id: 1,
    to_entity_id: 901,
    relationship_type_slug: "mentions",
    metadata: { sentiment: "positive" },
    confidence: 1,
    source: "ui",
  });

  const target = makeMockOrg("market", [
    {
      id: 100,
      name: "Acme Corporation",
      slug: "acme-corp",
      entity_type: "company",
      metadata: {
        primary_domain: "acme.com",
        tagline: "Existing market tagline", // must not be overwritten
      },
    },
    {
      id: 101,
      name: "Globex",
      slug: "globex",
      entity_type: "company",
      metadata: {},
    },
    {
      id: 102,
      name: "DupeCorp One",
      slug: "dupe-one",
      entity_type: "company",
      metadata: { primary_domain: "dupe.example" },
    },
    {
      id: 103,
      name: "DupeCorp Two",
      slug: "dupe-two",
      entity_type: "company",
      metadata: { primary_domain: "https://www.dupe.example/" },
    },
    {
      id: 104,
      name: "Initech",
      slug: "initech",
      entity_type: "company",
      metadata: {},
    },
    // Mirror the content entity so the mention re-target can resolve it.
    {
      id: 901,
      name: "TechCrunch article",
      entity_type: "content",
      metadata: {},
    },
  ]);

  return { source, target };
}

function makeDeps(opts: {
  source: MockOrg;
  target: MockOrg;
  apply: boolean;
  threshold?: number;
  matchOnly?: "domain" | "name" | "both";
}): MigrationDeps & { auditDir: string } {
  const auditDir = mkdtempSync(join(tmpdir(), "mi-migrate-"));
  return {
    source: makeOrgClient(opts.source),
    target: makeOrgClient(opts.target),
    audit: silentAudit(auditDir),
    apply: opts.apply,
    threshold: opts.threshold ?? 0.92,
    matchOnly: opts.matchOnly ?? "both",
    rateLimitPerSec: 1000,
    log: () => undefined,
    auditDir,
  };
}

// ── End-to-end ────────────────────────────────────────────────────────

describe("runMigration (dry-run)", () => {
  test("classifies fixture brands without writing", async () => {
    const fix = buildFixture();
    const deps = makeDeps({ ...fix, apply: false, threshold: 0.85 });

    const summary = await runMigration(deps);

    expect(summary.scanned).toBe(5);
    expect(summary.mergedDomain).toBe(1); // brand 1 → company 100
    expect(summary.mergedFuzzy).toBe(2); // brand 2 → company 101, brand 5 → company 104
    expect(summary.ambiguous).toBe(1); // brand 3 → 102+103
    expect(summary.created).toBe(1); // brand 4 → new company

    // No writes whatsoever in dry-run.
    expect(fix.target.creates).toHaveLength(0);
    expect(fix.target.updates).toHaveLength(0);
    expect(fix.target.links).toHaveLength(0);

    // Mention re-target is logged but no link is created.
    expect(summary.mentionsRetargeted).toBe(1);
    expect(fix.target.links).toHaveLength(0);

    // Audit log has every decision.
    const entries = readAuditLog(deps.audit.path);
    const decisions = new Set(entries.map((e) => e.decision));
    for (const expected of [
      "merged-domain",
      "merged-name-fuzzy",
      "ambiguous-skipped",
      "created",
      "mention-retargeted",
    ] as const) {
      expect(decisions.has(expected)).toBe(true);
    }
    // Every entry tagged dry_run.
    expect(entries.every((e) => e.dry_run === true)).toBe(true);
  });
});

describe("runMigration (apply)", () => {
  test("merges into matched companies and creates new ones", async () => {
    const fix = buildFixture();
    const deps = makeDeps({ ...fix, apply: true, threshold: 0.85 });

    const summary = await runMigration(deps);

    expect(summary.mergedDomain).toBe(1);
    expect(summary.mergedFuzzy).toBe(2);
    expect(summary.created).toBe(1);
    expect(summary.ambiguous).toBe(1);

    // Acme — existing tagline preserved, brand fields filled.
    const acme = fix.target.entities.get(100)!;
    expect(acme.metadata).toMatchObject({
      tagline: "Existing market tagline", // not overwritten
      logo_url: "https://acme.com/logo.png",
      social_handles: { twitter: "@acme" },
    });

    // Globex — fuzzy match merged tagline from MI's "positioning".
    const globex = fix.target.entities.get(101)!;
    expect(globex.metadata).toMatchObject({
      tagline: "industrial automation",
    });

    // FreshBrand — created.
    const fresh = [...fix.target.entities.values()].find(
      (e) => e.name === "FreshBrand"
    );
    expect(fresh).toBeDefined();
    expect(fresh?.entity_type).toBe("company");
    expect(fresh?.metadata).toMatchObject({
      tagline: "All new",
      // Domain is canonicalized so the next run can match by domain.
      primary_domain: "freshbrand.io",
      social_handles: { linkedin: "company/freshbrand" },
    });

    // Mention re-targeted.
    expect(summary.mentionsRetargeted).toBe(1);
    expect(fix.target.links).toHaveLength(1);
    expect(fix.target.links[0]).toMatchObject({
      from_entity_id: 100, // matched company
      to_entity_id: 901,
      relationship_type_slug: "mentions",
    });
  });

  test("--match-only=domain skips fuzzy fallback", async () => {
    const fix = buildFixture();
    const deps = makeDeps({
      ...fix,
      apply: true,
      threshold: 0.85,
      matchOnly: "domain",
    });
    const summary = await runMigration(deps);
    // Globex Industries no longer has a domain — it would fuzzy-match
    // against company 101 with `both` mode, but `domain` mode doesn't
    // try fuzzy, so it falls into the "no-match → create" bucket.
    expect(summary.mergedFuzzy).toBe(0);
    expect(summary.created).toBeGreaterThanOrEqual(1);
  });
});

describe("idempotency", () => {
  test("second apply run is a noop for matched brands", async () => {
    const fix = buildFixture();
    // First apply.
    {
      const deps = makeDeps({ ...fix, apply: true, threshold: 0.85 });
      await runMigration(deps);
    }

    const updatesBefore = fix.target.updates.length;
    const createsBefore = fix.target.creates.length;
    const linksBefore = fix.target.links.length;

    // Second apply on the *same* state.
    const deps2 = makeDeps({ ...fix, apply: true, threshold: 0.85 });
    const summary2 = await runMigration(deps2);

    // Every previously-merged brand emits noop now.
    expect(summary2.mergedDomain).toBe(0);
    expect(summary2.mergedFuzzy).toBe(0);
    expect(summary2.created).toBe(0);
    expect(summary2.noop).toBeGreaterThanOrEqual(2);

    // No new entity creates or updates on the second run.
    expect(fix.target.creates.length).toBe(createsBefore);
    expect(fix.target.updates.length).toBe(updatesBefore);

    // Mentions: the existing target link is detected; no duplicate is created.
    expect(fix.target.links.length).toBe(linksBefore);
    expect(summary2.mentionsRetargeted).toBe(1); // counted, but as a noop
  });
});

describe("same-run dedup", () => {
  test("two brands with the same domain don't both create new companies", async () => {
    const source = makeMockOrg("market-intelligence", [
      {
        id: 1,
        name: "Acme A",
        slug: "acme-a",
        entity_type: "brand",
        metadata: {
          primary_domain: "https://acme.example",
          tagline: "First brand wins",
        },
      },
      {
        id: 2,
        name: "Acme B",
        slug: "acme-b",
        entity_type: "brand",
        metadata: {
          primary_domain: "https://acme.example",
          brand_voice: "Second brand fills voice",
        },
      },
    ]);
    const target = makeMockOrg("market", []);
    const deps = makeDeps({ source, target, apply: true, threshold: 0.92 });

    const summary = await runMigration(deps);

    // First brand creates; second sees the in-memory company and merges
    // its remaining brand fields in.
    expect(summary.created).toBe(1);
    expect(summary.mergedDomain).toBe(1);
    expect(target.creates).toHaveLength(1);

    // The single created company carries fields from BOTH brands.
    expect(target.creates[0]?.metadata).toMatchObject({
      tagline: "First brand wins",
    });
    const created = [...target.entities.values()].find(
      (e) => e.entity_type === "company"
    );
    expect(created?.metadata).toMatchObject({
      tagline: "First brand wins",
      brand_voice: "Second brand fills voice",
    });
  });
});

describe("audit log shape", () => {
  test("every record carries dry_run + ts + decision", async () => {
    const fix = buildFixture();
    const deps = makeDeps({ ...fix, apply: false, threshold: 0.85 });
    await runMigration(deps);
    const entries = readAuditLog(deps.audit.path);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.ts).toBe("string");
      expect(typeof e.decision).toBe("string");
      expect(e.dry_run).toBe(true);
    }
  });
});
