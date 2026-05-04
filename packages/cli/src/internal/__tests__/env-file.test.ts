import { describe, expect, test } from "bun:test";
import { parseEnvContent } from "../env-file";

describe("parseEnvContent", () => {
  test("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("returns empty object for empty input", () => {
    expect(parseEnvContent("")).toEqual({});
  });

  test("skips blank lines and comments", () => {
    const content = `
# this is a comment
FOO=bar

  # indented comment
BAZ=qux
`;
    expect(parseEnvContent(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips lines without an equals sign", () => {
    const content = "FOO=bar\nNOEQUALS\nBAZ=qux";
    expect(parseEnvContent(content)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips matched double quotes around value", () => {
    expect(parseEnvContent('FOO="hello world"')).toEqual({
      FOO: "hello world",
    });
  });

  test("strips matched single quotes around value", () => {
    expect(parseEnvContent("FOO='hello world'")).toEqual({
      FOO: "hello world",
    });
  });

  test("does not strip mismatched quotes", () => {
    expect(parseEnvContent("FOO=\"hello'")).toEqual({ FOO: "\"hello'" });
  });

  test("does not strip a single character that looks like a quote", () => {
    // value of length < 2 should not be stripped
    expect(parseEnvContent('FOO="')).toEqual({ FOO: '"' });
  });

  test("rejects keys that do not match the POSIX shell identifier pattern", () => {
    const content = "1FOO=bar\nFOO-BAR=baz\nVALID_KEY=ok";
    expect(parseEnvContent(content)).toEqual({ VALID_KEY: "ok" });
  });

  test("allows keys starting with underscore", () => {
    expect(parseEnvContent("_FOO=bar")).toEqual({ _FOO: "bar" });
  });

  test("later occurrences of the same key overwrite earlier ones", () => {
    const content = "FOO=first\nFOO=second\nFOO=third";
    expect(parseEnvContent(content)).toEqual({ FOO: "third" });
  });

  test("handles values containing equals signs", () => {
    expect(parseEnvContent("URL=https://example.com/path?a=1&b=2")).toEqual({
      URL: "https://example.com/path?a=1&b=2",
    });
  });

  test("trims whitespace around key and value", () => {
    expect(parseEnvContent("  FOO  =   bar  ")).toEqual({ FOO: "bar" });
  });

  test("preserves empty values", () => {
    expect(parseEnvContent("FOO=")).toEqual({ FOO: "" });
  });
});
