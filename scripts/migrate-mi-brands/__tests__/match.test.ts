import { describe, expect, test } from "bun:test";
import {
  type BrandLike,
  type CompanyCandidate,
  canonicalizeDomain,
  jaroWinkler,
  matchBrand,
  normalizeName,
  pickDomainFromMetadata,
} from "../match.ts";

describe("canonicalizeDomain", () => {
  test("strips protocol + www + path + port", () => {
    expect(canonicalizeDomain("https://www.Example.com:8080/about?x=1")).toBe(
      "example.com"
    );
  });

  test("accepts bare hostnames", () => {
    expect(canonicalizeDomain("example.com")).toBe("example.com");
    expect(canonicalizeDomain(" Example.COM ")).toBe("example.com");
  });

  test("preserves non-www subdomains", () => {
    expect(canonicalizeDomain("eu.example.com")).toBe("eu.example.com");
    expect(canonicalizeDomain("https://api.example.com/")).toBe(
      "api.example.com"
    );
  });

  test("handles protocol-relative URLs", () => {
    expect(canonicalizeDomain("//www.example.com")).toBe("example.com");
  });

  test("strips userinfo", () => {
    expect(canonicalizeDomain("https://user:pass@example.com/")).toBe(
      "example.com"
    );
  });

  test("rejects non-host inputs", () => {
    expect(canonicalizeDomain("")).toBeNull();
    expect(canonicalizeDomain(undefined)).toBeNull();
    expect(canonicalizeDomain("nothing")).toBeNull();
    expect(canonicalizeDomain("space in.host")).toBeNull();
    expect(canonicalizeDomain(123)).toBeNull();
  });

  test("strips trailing dots", () => {
    expect(canonicalizeDomain("example.com.")).toBe("example.com");
  });
});

describe("pickDomainFromMetadata", () => {
  test("walks the candidate list in order", () => {
    expect(
      pickDomainFromMetadata({
        primary_domain: "primary.com",
        homepage_url: "https://homepage.com",
      })
    ).toBe("primary.com");
    expect(
      pickDomainFromMetadata({ homepage_url: "https://homepage.com" })
    ).toBe("https://homepage.com");
  });

  test("ignores empty / non-string fields", () => {
    expect(
      pickDomainFromMetadata({ primary_domain: "", domain: "real.com" })
    ).toBe("real.com");
    expect(pickDomainFromMetadata({ domain: 42 })).toBeNull();
    expect(pickDomainFromMetadata(null)).toBeNull();
    expect(pickDomainFromMetadata(undefined)).toBeNull();
  });

  test("falls through past uncanonicalizable values to a valid later field", () => {
    expect(
      pickDomainFromMetadata({
        primary_domain: "not a host",
        website: "https://real.example.com/path",
      })
    ).toBe("https://real.example.com/path");
  });
});

describe("normalizeName", () => {
  test("strips standard company suffixes", () => {
    expect(normalizeName("Acme Inc.")).toBe("acme");
    expect(normalizeName("Acme, LLC")).toBe("acme");
    expect(normalizeName("Acme Corporation")).toBe("acme");
    expect(normalizeName("Acme GmbH")).toBe("acme");
  });

  test("strips dotted suffix forms (L.L.C., S.A., …)", () => {
    expect(normalizeName("Acme L.L.C.")).toBe("acme");
    expect(normalizeName("Acme, L.L.C")).toBe("acme");
    expect(normalizeName("Société Générale S.A.")).toBe("societe generale");
  });

  test("collapses non-alphanumerics + lowercases", () => {
    expect(normalizeName("  ACME—Foo!! ")).toBe("acme foo");
  });

  test("strips diacritics", () => {
    expect(normalizeName("Café Société")).toBe("cafe societe");
  });

  test("idempotent on already-clean strings", () => {
    expect(normalizeName(normalizeName("Acme Inc"))).toBe("acme");
  });

  test("handles non-string input", () => {
    expect(normalizeName(undefined)).toBe("");
    expect(normalizeName(42)).toBe("");
  });
});

describe("jaroWinkler", () => {
  test("identical strings → 1", () => {
    expect(jaroWinkler("acme", "acme")).toBe(1);
  });

  test("disjoint strings → 0", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  test("close strings score ≥ 0.9", () => {
    // From the Wikipedia worked example.
    const score = jaroWinkler("martha", "marhta");
    expect(score).toBeGreaterThan(0.9);
  });

  test("weak overlap stays well below 0.9", () => {
    expect(jaroWinkler("acme", "globex")).toBeLessThan(0.7);
  });
});

// ── matchBrand integration ─────────────────────────────────────────────

const COMPANIES: CompanyCandidate[] = [
  {
    id: 100,
    name: "Acme Corporation",
    metadata: { primary_domain: "https://acme.com" },
  },
  {
    id: 101,
    name: "Globex Industries",
    metadata: { homepage_url: "https://globex.io" },
  },
  {
    id: 102,
    name: "Hooli Cloud",
    metadata: { website: "hooli.com" },
  },
  {
    id: 103,
    name: "Initech",
    metadata: {},
  },
];

describe("matchBrand", () => {
  test("domain match wins (case + protocol normalized)", () => {
    const brand: BrandLike = {
      id: 1,
      name: "ACME co.",
      metadata: { homepage_url: "HTTP://www.ACME.com/about" },
    };
    const r = matchBrand(brand, COMPANIES, { threshold: 0.92 });
    expect(r.kind).toBe("domain");
    expect(r.company?.id).toBe(100);
    expect(r.score).toBe(1);
    expect(r.brandDomain).toBe("acme.com");
  });

  test("ambiguous when two companies share the canonical domain", () => {
    const brand: BrandLike = {
      id: 2,
      name: "Acme",
      metadata: { primary_domain: "https://acme.com" },
    };
    const dupe: CompanyCandidate[] = [
      ...COMPANIES,
      { id: 200, name: "Acme Holdings", metadata: { domain: "www.acme.com" } },
    ];
    const r = matchBrand(brand, dupe, { threshold: 0.92 });
    expect(r.kind).toBe("ambiguous");
    expect(r.candidates?.map((c) => c.id).sort()).toEqual([100, 200]);
  });

  test("falls through to fuzzy name match when no domain on brand", () => {
    const brand: BrandLike = {
      id: 3,
      name: "Acme Co.", // not "Acme Corporation" — fuzzy
      metadata: {},
    };
    const r = matchBrand(brand, COMPANIES, { threshold: 0.85 });
    expect(r.kind).toBe("name-fuzzy");
    expect(r.company?.id).toBe(100);
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  test("fuzzy match below threshold returns no-match with bestScore", () => {
    const brand: BrandLike = {
      id: 4,
      name: "AcmeXYZ Industries Ltd", // close to multiple, none clean
      metadata: {},
    };
    const r = matchBrand(brand, COMPANIES, { threshold: 0.999 });
    expect(r.kind).toBe("no-match");
    expect(r.bestScore ?? 0).toBeGreaterThan(0);
  });

  test("ambiguous when multiple candidates pass the threshold (any score)", () => {
    const fixture: CompanyCandidate[] = [
      { id: 1, name: "Acme", metadata: {} },
      { id: 2, name: "Acme Corp", metadata: {} },
      { id: 3, name: "Globex", metadata: {} },
    ];
    const brand: BrandLike = { id: 99, name: "Acme", metadata: {} };
    const r = matchBrand(brand, fixture, { threshold: 0.85 });
    // Both id=1 (exact match → 1.0) and id=2 (suffix-stripped → 1.0) are
    // above threshold; the matcher must report ambiguous, not silently
    // pick id=1 by ordering.
    expect(r.kind).toBe("ambiguous");
    expect(r.candidates?.map((c) => c.id).sort()).toEqual([1, 2]);
  });

  test("no-match when brand has no name and no domain", () => {
    const brand: BrandLike = { id: 5, name: "", metadata: {} };
    const r = matchBrand(brand, COMPANIES, { threshold: 0.92 });
    expect(r.kind).toBe("no-match");
  });

  test("--match-only=domain skips fuzzy fallback", () => {
    const brand: BrandLike = { id: 6, name: "Acme Corp", metadata: {} };
    const r = matchBrand(brand, COMPANIES, {
      threshold: 0.85,
      matchOnly: "domain",
    });
    expect(r.kind).toBe("no-match");
  });

  test("--match-only=name skips domain match", () => {
    const brand: BrandLike = {
      id: 7,
      name: "Globex Industries",
      metadata: { homepage_url: "https://globex.io" },
    };
    const r = matchBrand(brand, COMPANIES, {
      threshold: 0.85,
      matchOnly: "name",
    });
    // Even though domains match, we forced name-only mode.
    expect(r.kind).toBe("name-fuzzy");
    expect(r.company?.id).toBe(101);
  });
});
