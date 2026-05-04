import { describe, expect, test } from "bun:test";
import {
  buildToolPolicy,
  isDirectPackageInstallCommand,
  isToolAllowedByPolicy,
} from "../openclaw/tool-policy";

describe("isDirectPackageInstallCommand", () => {
  test("returns false for empty string", () => {
    expect(isDirectPackageInstallCommand("")).toBe(false);
  });

  test("returns false for whitespace-only string", () => {
    expect(isDirectPackageInstallCommand("   ")).toBe(false);
    expect(isDirectPackageInstallCommand("\t\n")).toBe(false);
  });

  test("returns true for prefix match (apt install)", () => {
    expect(isDirectPackageInstallCommand("apt install curl")).toBe(true);
  });

  test("returns true for npm install with -g flag", () => {
    expect(isDirectPackageInstallCommand("npm install -g typescript")).toBe(
      true
    );
  });

  test("returns true for embedded install via bash -c (regex pattern)", () => {
    expect(isDirectPackageInstallCommand("bash -lc 'pnpm add zod'")).toBe(true);
  });

  test("returns false for unrelated command", () => {
    expect(isDirectPackageInstallCommand("ls -la")).toBe(false);
  });
});

describe("isToolAllowedByPolicy — wildcard prefix matching", () => {
  test("pattern ending with * matches tools by prefix in strict mode", () => {
    // Triggers the `normalizedPatternLower.endsWith("*")` branch where the
    // pattern is NOT just "*" — uses startsWith on the prefix.
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["read*"] },
    });
    expect(isToolAllowedByPolicy("ReadFile", policy)).toBe(true);
    expect(isToolAllowedByPolicy("read", policy)).toBe(true);
    expect(isToolAllowedByPolicy("readme", policy)).toBe(true);
    expect(isToolAllowedByPolicy("write", policy)).toBe(false);
  });

  test("wildcard prefix in deny list blocks matching tools", () => {
    const policy = buildToolPolicy({
      toolsConfig: { strictMode: true, allowedTools: ["*"] },
      disallowedTools: ["write*"],
    });
    expect(isToolAllowedByPolicy("WriteFile", policy)).toBe(false);
    expect(isToolAllowedByPolicy("write", policy)).toBe(false);
    expect(isToolAllowedByPolicy("read", policy)).toBe(true);
  });
});
