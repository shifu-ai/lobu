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
