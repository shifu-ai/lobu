import { describe, expect, test } from "bun:test";
import {
  buildProjectedMcpSetupInstructions,
  resolveGatewayWorkerToken,
} from "../openclaw/session-runner";

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

describe("buildProjectedMcpSetupInstructions", () => {
  test("degraded MCP auth status asks the agent to retry later instead of starting login", () => {
    const instructions = buildProjectedMcpSetupInstructions(
      [
        {
          id: "shifu-toolbox",
          name: "ShiFu Toolbox",
          requiresAuth: true,
          authenticated: false,
          authStatus: "degraded",
          diagnosticCode: "auth_required_zero_tools",
          requiresInput: false,
          configured: true,
        },
      ],
      {},
      {}
    );

    expect(instructions).toContain("temporarily degraded");
    expect(instructions).toContain("try again later");
    expect(instructions).not.toContain("To start login");
  });
});
