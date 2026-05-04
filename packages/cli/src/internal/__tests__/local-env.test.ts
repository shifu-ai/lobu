import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocalEnvValue } from "../local-env";

describe("setLocalEnvValue", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "local-env-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("creates a new .env file when none exists", async () => {
    await setLocalEnvValue(workDir, "FOO", "bar");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe("FOO=bar");
  });

  test("appends a new key to an existing .env file", async () => {
    await writeFile(join(workDir, ".env"), "EXISTING=value\n");
    await setLocalEnvValue(workDir, "FOO", "bar");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe("EXISTING=value\nFOO=bar");
  });

  test("updates an existing key in place", async () => {
    await writeFile(join(workDir, ".env"), "FIRST=1\nFOO=old\nLAST=z\n");
    await setLocalEnvValue(workDir, "FOO", "new");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe("FIRST=1\nFOO=new\nLAST=z");
  });

  test("quotes values containing whitespace", async () => {
    await setLocalEnvValue(workDir, "GREETING", "hello world");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe('GREETING="hello world"');
  });

  test("quotes values containing special characters", async () => {
    await setLocalEnvValue(workDir, "QUOTED", 'has"quote');
    const content = await readFile(join(workDir, ".env"), "utf-8");
    // JSON.stringify escapes double quotes
    expect(content).toBe('QUOTED="has\\"quote"');
  });

  test("does not quote simple values", async () => {
    await setLocalEnvValue(workDir, "SIMPLE", "abc123");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe("SIMPLE=abc123");
  });

  test("preserves other lines when updating a key", async () => {
    await writeFile(
      join(workDir, ".env"),
      "# comment line\nA=1\nFOO=old\n# another comment\nB=2\n"
    );
    await setLocalEnvValue(workDir, "FOO", "updated");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe(
      "# comment line\nA=1\nFOO=updated\n# another comment\nB=2"
    );
  });

  test("matches keys including indentation", async () => {
    await writeFile(join(workDir, ".env"), "  FOO=indented\n");
    await setLocalEnvValue(workDir, "FOO", "new");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    // The line is rewritten without leading whitespace
    expect(content).toBe("FOO=new");
  });

  test("quotes values containing hash signs", async () => {
    await setLocalEnvValue(workDir, "HASHED", "a#b");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    expect(content).toBe('HASHED="a#b"');
  });

  test("quotes values containing backslashes", async () => {
    await setLocalEnvValue(workDir, "PATHY", "a\\b");
    const content = await readFile(join(workDir, ".env"), "utf-8");
    // JSON.stringify will escape the backslash
    expect(content).toBe('PATHY="a\\\\b"');
  });
});
