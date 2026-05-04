import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_DEFAULT_URL, resolveGatewayUrl } from "../gateway-url";

describe("resolveGatewayUrl", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "gateway-url-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("returns default URL when no .env file exists", async () => {
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe(GATEWAY_DEFAULT_URL);
  });

  test("uses GATEWAY_PORT from .env when set", async () => {
    await writeFile(join(workDir, ".env"), "GATEWAY_PORT=9999\n");
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe("http://localhost:9999");
  });

  test("falls back to PORT when GATEWAY_PORT is not set", async () => {
    await writeFile(join(workDir, ".env"), "PORT=4242\n");
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe("http://localhost:4242");
  });

  test("prefers GATEWAY_PORT over PORT when both are set", async () => {
    await writeFile(join(workDir, ".env"), "GATEWAY_PORT=9999\nPORT=4242\n");
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe("http://localhost:9999");
  });

  test("returns default URL when neither variable is set", async () => {
    await writeFile(join(workDir, ".env"), "OTHER=value\n");
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe(GATEWAY_DEFAULT_URL);
  });

  test("uses process.cwd() when cwd option not provided", async () => {
    // Just ensure it doesn't throw and returns a string URL.
    const url = await resolveGatewayUrl();
    expect(typeof url).toBe("string");
    expect(url.startsWith("http://localhost:")).toBe(true);
  });

  test("strips quotes from quoted port values", async () => {
    await writeFile(join(workDir, ".env"), 'GATEWAY_PORT="3001"\n');
    const url = await resolveGatewayUrl({ cwd: workDir });
    expect(url).toBe("http://localhost:3001");
  });
});
