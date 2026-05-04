import { describe, expect, test } from "bun:test";
import { ensureBaseUrl } from "../utils/urls";

describe("ensureBaseUrl", () => {
  test("preserves URLs that already have http://", () => {
    expect(ensureBaseUrl("http://example.com")).toBe("http://example.com");
  });

  test("preserves URLs that already have https://", () => {
    expect(ensureBaseUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
  });

  test("prepends http:// to bare hostnames", () => {
    expect(ensureBaseUrl("example.com")).toBe("http://example.com");
  });

  test("prepends http:// to host:port", () => {
    expect(ensureBaseUrl("localhost:3000")).toBe("http://localhost:3000");
  });

  test("prepends http:// to host with path", () => {
    expect(ensureBaseUrl("api.example.com/v1")).toBe(
      "http://api.example.com/v1"
    );
  });

  test("does not double-prepend prefix that contains http within string", () => {
    // Only the literal startsWith("http://") / startsWith("https://") matters.
    // A path-like string starting with /http should still get prepended.
    expect(ensureBaseUrl("/http")).toBe("http:///http");
  });

  test("treats other protocols as needing the http:// prefix (current behavior)", () => {
    // Documenting that ftp:// is NOT recognized — gets http:// prepended.
    expect(ensureBaseUrl("ftp://files.example.com")).toBe(
      "http://ftp://files.example.com"
    );
  });

  test("handles empty string by prepending http://", () => {
    expect(ensureBaseUrl("")).toBe("http://");
  });
});
