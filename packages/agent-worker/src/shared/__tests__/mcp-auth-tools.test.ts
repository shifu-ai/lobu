import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  startMcpLogin,
  type GatewayParams,
  type ToolContentResult,
} from "../tool-implementations";

const GW: GatewayParams = {
  gatewayUrl: "http://gateway.internal:8080",
  workerToken: "test-token",
} as GatewayParams;

let originalFetch: typeof globalThis.fetch;

function stubGateway(startBody: unknown) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("/internal/device-auth/status")) {
      return Response.json({ authenticated: false });
    }
    if (url.includes("/internal/device-auth/start")) {
      return Response.json(startBody);
    }
    if (url.includes("/internal/interactions")) {
      return Response.json({ id: "int-1" });
    }
    return new Response("unexpected", { status: 500 });
  }) as any;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function parseResult(result: ToolContentResult) {
  const text = result.content.find((part) => part.type === "text")?.text;
  return JSON.parse(text!);
}

describe("startMcpLogin message copy", () => {
  test("auth_code fallback -> instructs agent to send the URL as plain text", async () => {
    stubGateway({
      flow: "auth_code",
      userCode: "",
      verificationUri: "https://gw.example.com/mcp/oauth/start?token=abc",
      verificationUriComplete:
        "https://gw.example.com/mcp/oauth/start?token=abc",
      expiresIn: 900,
    });
    const parsed = parseResult(await startMcpLogin(GW, { mcpId: "notion" }));
    expect(parsed.status).toBe("login_started");
    expect(parsed.verification_url).toContain("/mcp/oauth/start?token=abc");
    expect(parsed.message).toContain("plain text");
    expect(parsed.message).toContain(
      "https://gw.example.com/mcp/oauth/start?token=abc"
    );
    expect(parsed.message).toContain("notion_login_check");
    expect(parsed.message).not.toContain("Do not repeat the URL");
  });

  test("device flow -> also instructs plain-text send and includes user code", async () => {
    stubGateway({
      userCode: "ABCD-1234",
      verificationUri: "https://idp.example.com/device",
      verificationUriComplete:
        "https://idp.example.com/device?user_code=ABCD-1234",
      expiresIn: 600,
    });
    const parsed = parseResult(
      await startMcpLogin(GW, { mcpId: "shifu-toolbox" })
    );
    expect(parsed.message).toContain("plain text");
    expect(parsed.message).toContain("ABCD-1234");
    expect(parsed.message).not.toContain("has been sent directly to the user");
  });
});
