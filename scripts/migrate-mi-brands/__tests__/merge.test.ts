import { describe, expect, test } from "bun:test";
import {
  brandToNewCompanyMetadata,
  extractBrandFields,
  mergeBrandIntoCompany,
} from "../merge.ts";

describe("extractBrandFields", () => {
  test("pulls every supported field", () => {
    expect(
      extractBrandFields({
        logo_url: "https://acme.com/logo.png",
        tagline: "We build things",
        brand_voice: "playful",
        social_handles: {
          twitter: "@acme",
          linkedin: "company/acme",
          github: "acme",
        },
      })
    ).toEqual({
      logo_url: "https://acme.com/logo.png",
      tagline: "We build things",
      brand_voice: "playful",
      social_handles: {
        twitter: "@acme",
        linkedin: "company/acme",
        github: "acme",
      },
    });
  });

  test("aliases tagline ← positioning, voice ← tone_of_voice", () => {
    const out = extractBrandFields({
      positioning: "the dev tools for teams",
      tone_of_voice: "direct",
    });
    expect(out.tagline).toBe("the dev tools for teams");
    expect(out.brand_voice).toBe("direct");
  });

  test("flat social_* fields are folded into social_handles", () => {
    const out = extractBrandFields({
      twitter_url: "https://x.com/acme",
      linkedin_url: "https://linkedin.com/company/acme",
      github_handle: "acme",
    });
    expect(out.social_handles).toEqual({
      twitter: "https://x.com/acme",
      linkedin: "https://linkedin.com/company/acme",
      github: "acme",
    });
  });

  test("nested social_handles takes precedence over flat siblings", () => {
    const out = extractBrandFields({
      social_handles: { twitter: "@nested" },
      twitter_handle: "@flat",
    });
    expect(out.social_handles).toEqual({ twitter: "@nested" });
  });

  test("ignores empty strings + non-string types", () => {
    const out = extractBrandFields({
      tagline: "",
      brand_voice: 42,
      logo_url: "  ",
    });
    expect(out).toEqual({});
  });

  test("returns empty object for null / undefined metadata", () => {
    expect(extractBrandFields(null)).toEqual({});
    expect(extractBrandFields(undefined)).toEqual({});
  });
});

describe("mergeBrandIntoCompany", () => {
  test("fills missing scalar fields without overwriting", () => {
    const r = mergeBrandIntoCompany(
      { tagline: "company tagline (kept)", logo_url: "" },
      {
        logo_url: "https://acme.com/logo.png",
        tagline: "brand tagline (dropped)",
        brand_voice: "playful",
      }
    );
    expect(r.changed).toBe(true);
    expect(r.metadata).toMatchObject({
      tagline: "company tagline (kept)",
      logo_url: "https://acme.com/logo.png",
      brand_voice: "playful",
    });
    expect(r.filledFields.sort()).toEqual(["brand_voice", "logo_url"]);
  });

  test("fills only the missing social_handles subkeys", () => {
    const r = mergeBrandIntoCompany(
      { social_handles: { twitter: "@company" } },
      {
        social_handles: {
          twitter: "@brand",
          linkedin: "company/brand",
          github: "brand",
        },
      }
    );
    expect(r.changed).toBe(true);
    expect(r.metadata.social_handles).toEqual({
      twitter: "@company",
      linkedin: "company/brand",
      github: "brand",
    });
    expect(r.filledFields.sort()).toEqual([
      "social_handles.github",
      "social_handles.linkedin",
    ]);
  });

  test("returns changed=false when nothing to fill", () => {
    const r = mergeBrandIntoCompany(
      {
        tagline: "kept",
        logo_url: "kept",
        brand_voice: "kept",
        social_handles: { twitter: "@kept", linkedin: "kept" },
      },
      {
        tagline: "brand",
        logo_url: "brand",
        brand_voice: "brand",
        social_handles: { twitter: "@brand", linkedin: "brand" },
      }
    );
    expect(r.changed).toBe(false);
    expect(r.filledFields).toEqual([]);
  });

  test("works against null company metadata", () => {
    const r = mergeBrandIntoCompany(null, {
      tagline: "tagline",
    });
    expect(r.changed).toBe(true);
    expect(r.metadata).toEqual({ tagline: "tagline" });
  });

  test("treats whitespace-only strings as empty", () => {
    const r = mergeBrandIntoCompany(
      { tagline: "   " },
      { tagline: "real tagline" }
    );
    expect(r.changed).toBe(true);
    expect(r.metadata.tagline).toBe("real tagline");
  });

  test("idempotent — second merge over the result is a noop", () => {
    const first = mergeBrandIntoCompany(
      {},
      {
        logo_url: "https://acme.com/logo.png",
        tagline: "Hi",
        social_handles: { twitter: "@acme" },
      }
    );
    expect(first.changed).toBe(true);
    const second = mergeBrandIntoCompany(first.metadata, {
      logo_url: "https://acme.com/logo.png",
      tagline: "Hi",
      social_handles: { twitter: "@acme" },
    });
    expect(second.changed).toBe(false);
  });
});

describe("brandToNewCompanyMetadata", () => {
  test("builds a clean metadata object for the no-match path", () => {
    expect(
      brandToNewCompanyMetadata({
        logo_url: "https://acme.com/logo.png",
        tagline: "Hi",
        brand_voice: "warm",
        social_handles: {
          twitter: "@acme",
          linkedin: "" as string | undefined,
        },
      })
    ).toEqual({
      logo_url: "https://acme.com/logo.png",
      tagline: "Hi",
      brand_voice: "warm",
      social_handles: { twitter: "@acme" },
    });
  });

  test("omits empty social_handles entirely", () => {
    expect(brandToNewCompanyMetadata({ tagline: "Hi" })).toEqual({
      tagline: "Hi",
    });
  });
});
