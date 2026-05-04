import { describe, expect, test } from "bun:test";
import {
  createBuiltinSecretRef,
  isSecretRef,
  parseSecretRef,
} from "../secret-refs";

describe("secret refs", () => {
  test("parses builtin refs", () => {
    expect(parseSecretRef("secret://agents/test/key")).toEqual({
      raw: "secret://agents/test/key",
      scheme: "secret",
      path: "agents/test/key",
    });
  });

  test("parses aws refs with fragment", () => {
    expect(parseSecretRef("aws-sm:///prod/openai#apiKey")).toEqual({
      raw: "aws-sm:///prod/openai#apiKey",
      scheme: "aws-sm",
      path: "/prod/openai",
      fragment: "apiKey",
    });
  });

  test("rejects non-secret refs", () => {
    expect(parseSecretRef("not-a-ref")).toBeNull();
    expect(isSecretRef("not-a-ref")).toBe(false);
  });

  test("builds builtin refs", () => {
    expect(createBuiltinSecretRef("system-env/OPENAI_API_KEY")).toBe(
      "secret://system-env/OPENAI_API_KEY"
    );
  });
});

describe("parseSecretRef extra coverage", () => {
  test("parses simple secret ref", () => {
    expect(parseSecretRef("secret://name")).toEqual({
      raw: "secret://name",
      scheme: "secret",
      path: "name",
    });
  });

  test("parses ref with fragment", () => {
    expect(parseSecretRef("secret://name#frag")).toEqual({
      raw: "secret://name#frag",
      scheme: "secret",
      path: "name",
      fragment: "frag",
    });
  });

  test("scheme is lowercased even when written in mixed case", () => {
    const parsed = parseSecretRef("AWS-SM://prod/openai");
    expect(parsed).not.toBeNull();
    expect(parsed?.scheme).toBe("aws-sm");
    expect(parsed?.path).toBe("prod/openai");
    expect(parsed?.raw).toBe("AWS-SM://prod/openai");
  });

  test("parses scheme with allowed special characters", () => {
    expect(parseSecretRef("aws.sm+v1-test://foo")?.scheme).toBe(
      "aws.sm+v1-test"
    );
  });

  test("parses complex multi-segment paths", () => {
    expect(parseSecretRef("vault://path/to/some/secret/value")).toEqual({
      raw: "vault://path/to/some/secret/value",
      scheme: "vault",
      path: "path/to/some/secret/value",
    });
  });

  test("returns null when there is no scheme", () => {
    expect(parseSecretRef("just-a-string")).toBeNull();
    expect(parseSecretRef("//missing-scheme")).toBeNull();
  });

  test("returns null for malformed refs", () => {
    expect(parseSecretRef("")).toBeNull();
    expect(parseSecretRef("secret:/")).toBeNull();
    expect(parseSecretRef("secret://")).toBeNull();
  });

  test("returns null when scheme starts with a digit", () => {
    expect(parseSecretRef("1bad://foo")).toBeNull();
  });

  test("splits on the first '#' for path/fragment", () => {
    const parsed = parseSecretRef("secret://path#frag#more");
    expect(parsed?.path).toBe("path");
    // String.split("#", 2) keeps only the first two segments.
    expect(parsed?.fragment).toBe("frag");
  });

  test("omits fragment field when fragment is empty", () => {
    const parsed = parseSecretRef("secret://path#");
    expect(parsed).not.toBeNull();
    expect(parsed?.path).toBe("path");
    expect(parsed).not.toHaveProperty("fragment");
  });
});

describe("isSecretRef extra coverage", () => {
  test("returns true for valid refs", () => {
    expect(isSecretRef("secret://foo")).toBe(true);
    expect(isSecretRef("aws-sm:///prod/openai#apiKey")).toBe(true);
  });

  test("returns false for non-strings", () => {
    expect(isSecretRef(undefined)).toBe(false);
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef(123)).toBe(false);
    expect(isSecretRef({})).toBe(false);
    expect(isSecretRef([])).toBe(false);
    expect(isSecretRef(true)).toBe(false);
  });

  test("returns false for malformed strings", () => {
    expect(isSecretRef("")).toBe(false);
    expect(isSecretRef("not a ref")).toBe(false);
    expect(isSecretRef("://nope")).toBe(false);
  });
});

describe("createBuiltinSecretRef extra coverage", () => {
  test("produces the secret:// scheme prefix", () => {
    expect(createBuiltinSecretRef("foo")).toBe("secret://foo");
  });

  test("output round-trips through parseSecretRef", () => {
    const ref = createBuiltinSecretRef("agents/test/key");
    const parsed = parseSecretRef(ref);
    expect(parsed).toEqual({
      raw: "secret://agents/test/key",
      scheme: "secret",
      path: "agents/test/key",
    });
  });

  test("output is recognised by isSecretRef", () => {
    expect(isSecretRef(createBuiltinSecretRef("x"))).toBe(true);
  });
});
