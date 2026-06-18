import { describe, expect, test } from "bun:test";
import { resolveGatewayWorkerToken } from "../openclaw/session-runner";

describe("resolveGatewayWorkerToken", () => {
  test("prefers the per-run worker token over the deployment token", () => {
    expect(resolveGatewayWorkerToken("run-token", "env-token")).toBe(
      "run-token"
    );
  });

  test("falls back to the deployment token for legacy jobs", () => {
    expect(resolveGatewayWorkerToken(undefined, "env-token")).toBe("env-token");
  });
});
