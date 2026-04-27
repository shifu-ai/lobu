import { describe, expect, test } from "bun:test";
import {
  buildTechnologySpec,
  slugifyTechnology,
  TECHNOLOGIES,
} from "../technologies.ts";

describe("slugifyTechnology", () => {
  test("lowercases and hyphenates", () => {
    expect(slugifyTechnology("React Native")).toBe("react-native");
    expect(slugifyTechnology("Tailwind CSS")).toBe("tailwind-css");
  });

  test("handles ++ and # specially", () => {
    expect(slugifyTechnology("C++")).toBe("cpp");
    expect(slugifyTechnology("C#")).toBe("csharp");
    expect(slugifyTechnology("F#")).toBe("fsharp");
  });

  test("strips trailing dots/punctuation", () => {
    expect(slugifyTechnology("Vue.js")).toBe("vue-js");
    expect(slugifyTechnology("Node.js")).toBe("node-js");
    expect(slugifyTechnology("  Foo!!  ")).toBe("foo");
  });
});

describe("buildTechnologySpec", () => {
  test("produces canonical-key spec for a known tech", () => {
    const spec = buildTechnologySpec({
      name: "PostgreSQL",
      category: "database",
      homepage_url: "https://www.postgresql.org",
    });
    expect(spec).toMatchObject({
      entityType: "technology",
      name: "PostgreSQL",
      slug: "postgresql",
      canonicalKey: "postgresql",
      canonicalKeyField: "slug",
      metadata: {
        category: "database",
        homepage_url: "https://www.postgresql.org",
      },
    });
    // No synthetic `slug` field smuggled into metadata.
    expect((spec.metadata as Record<string, unknown>).slug).toBeUndefined();
  });

  test("omits homepage_url when not provided", () => {
    const spec = buildTechnologySpec({ name: "C", category: "language" });
    expect(spec.metadata.homepage_url).toBeUndefined();
  });
});

describe("TECHNOLOGIES seed list", () => {
  test("all entries have unique slugs", () => {
    const slugs = TECHNOLOGIES.map((t) => slugifyTechnology(t.name));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("list size is in the curated ~200 range", () => {
    expect(TECHNOLOGIES.length).toBeGreaterThanOrEqual(150);
    expect(TECHNOLOGIES.length).toBeLessThanOrEqual(300);
  });
});
