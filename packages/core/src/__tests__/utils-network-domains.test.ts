import { describe, expect, test } from "bun:test";
import {
  normalizeDomainPattern,
  normalizeDomainPatterns,
} from "../utils/network-domains";

describe("normalizeDomainPattern", () => {
  test("trims whitespace", () => {
    expect(normalizeDomainPattern("  example.com  ")).toBe("example.com");
  });

  test("lowercases the input", () => {
    expect(normalizeDomainPattern("Example.COM")).toBe("example.com");
  });

  test("converts '*.foo.com' to '.foo.com'", () => {
    expect(normalizeDomainPattern("*.example.com")).toBe(".example.com");
  });

  test("preserves leading-dot wildcard form", () => {
    expect(normalizeDomainPattern(".example.com")).toBe(".example.com");
  });

  test("preserves regex-style patterns starting with '/'", () => {
    expect(normalizeDomainPattern("/^api\\..*\\.com$/")).toBe(
      "/^api\\..*\\.com$/"
    );
  });

  test("does not lowercase regex patterns", () => {
    // Regex patterns are returned as-is after trim — case preserved
    expect(normalizeDomainPattern("  /API_REGEX/  ")).toBe("/API_REGEX/");
  });

  test("normalizes wildcard with mixed case", () => {
    expect(normalizeDomainPattern("*.EXAMPLE.com")).toBe(".example.com");
  });

  test("returns empty string for empty input", () => {
    expect(normalizeDomainPattern("")).toBe("");
    expect(normalizeDomainPattern("   ")).toBe("");
  });
});

describe("normalizeDomainPatterns", () => {
  test("returns undefined for undefined input", () => {
    expect(normalizeDomainPatterns(undefined)).toBeUndefined();
  });

  test("normalizes each pattern in the list", () => {
    expect(
      normalizeDomainPatterns(["Example.com", "*.Foo.org", "  bar.io  "])
    ).toEqual(["example.com", ".foo.org", "bar.io"]);
  });

  test("dedupes after normalization", () => {
    expect(
      normalizeDomainPatterns(["example.com", "EXAMPLE.com", "  example.com "])
    ).toEqual(["example.com"]);
  });

  test("filters out empty strings produced by normalization", () => {
    expect(normalizeDomainPatterns(["", "   ", "good.com"])).toEqual([
      "good.com",
    ]);
  });

  test("returns empty array for all-empty input", () => {
    expect(normalizeDomainPatterns([])).toEqual([]);
    expect(normalizeDomainPatterns(["", "   "])).toEqual([]);
  });

  test("preserves regex patterns alongside normalized ones", () => {
    expect(normalizeDomainPatterns(["/^api\\..*$/", "Example.com"])).toEqual([
      "/^api\\..*$/",
      "example.com",
    ]);
  });
});
