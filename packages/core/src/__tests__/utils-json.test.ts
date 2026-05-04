import { describe, expect, test } from "bun:test";
import { safeJsonParse, safeJsonStringify } from "../utils/json";

describe("safeJsonParse", () => {
  test("parses valid JSON object", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  test("parses valid JSON array", () => {
    expect(safeJsonParse<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("parses primitives", () => {
    expect(safeJsonParse<number>("42")).toBe(42);
    expect(safeJsonParse<string>('"hello"')).toBe("hello");
    expect(safeJsonParse<boolean>("true")).toBe(true);
    expect(safeJsonParse<null>("null")).toBe(null);
  });

  test("returns null on invalid JSON by default", () => {
    expect(safeJsonParse("not json")).toBe(null);
    expect(safeJsonParse("{")).toBe(null);
    expect(safeJsonParse("")).toBe(null);
  });

  test("returns provided fallback on parse failure", () => {
    expect(safeJsonParse("garbage", { fallback: true })).toEqual({
      fallback: true,
    });
    expect(safeJsonParse<number>("not a number", 99)).toBe(99);
  });

  test("preserves explicit null fallback", () => {
    expect(safeJsonParse("bad", null)).toBe(null);
  });

  test("handles long input by truncating preview without throwing", () => {
    // Logger preview substring(0, 100) — make sure parse failure with long input is handled
    const long = "{".repeat(500);
    expect(safeJsonParse(long)).toBe(null);
  });
});

describe("safeJsonStringify", () => {
  test("stringifies plain objects", () => {
    expect(safeJsonStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("stringifies primitives", () => {
    expect(safeJsonStringify(42)).toBe("42");
    expect(safeJsonStringify("hi")).toBe('"hi"');
    expect(safeJsonStringify(true)).toBe("true");
    expect(safeJsonStringify(null)).toBe("null");
  });

  test("stringifies arrays", () => {
    expect(safeJsonStringify([1, "a", null])).toBe('[1,"a",null]');
  });

  test("returns null on circular reference", () => {
    const obj: Record<string, unknown> = { name: "loop" };
    obj.self = obj;
    expect(safeJsonStringify(obj)).toBe(null);
  });

  test("returns null on BigInt (which throws on stringify)", () => {
    expect(safeJsonStringify(BigInt(123))).toBe(null);
  });

  test("returns 'undefined' string for undefined input becomes undefined value (JSON.stringify quirk)", () => {
    // JSON.stringify(undefined) returns undefined (not a string), which is not null
    // so safeJsonStringify will return undefined (the original behavior of JSON.stringify).
    // Confirm we surface that as-is rather than throwing.
    const result = safeJsonStringify(undefined);
    expect(result === undefined || result === null).toBe(true);
  });
});
