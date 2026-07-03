import { describe, expect, test } from "bun:test";

// 與 mcp-oauth.test.ts 同慣例：pin 決定性 ENCRYPTION_KEY
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { buildMcpConnectUrl } from "../../auth/mcp/connect-link-url.js";
import { verifyConnectLinkToken } from "../../auth/mcp/connect-link-token.js";

describe("buildMcpConnectUrl", () => {
  const base = {
    agentId: "shifu-u-test",
    mcpId: "notion",
    userId: "user-1",
    organizationId: "org_test",
  };

  test("returns https connect URL whose token round-trips with the correct binding", () => {
    const url = buildMcpConnectUrl({
      ...base,
      publicGatewayUrl: "https://gateway.example.com/",
    });
    expect(url).toBeDefined();
    const parsed = new URL(url!);
    expect(parsed.pathname).toBe("/mcp/oauth/start");
    const payload = verifyConnectLinkToken(parsed.searchParams.get("token")!);
    expect(payload).toMatchObject({
      agentId: "shifu-u-test",
      mcpId: "notion",
      userId: "user-1",
      organizationId: "org_test",
    });
  });

  test("returns undefined when publicGatewayUrl missing", () => {
    expect(buildMcpConnectUrl({ ...base, publicGatewayUrl: undefined })).toBeUndefined();
  });

  test("returns undefined when publicGatewayUrl is not https", () => {
    expect(
      buildMcpConnectUrl({ ...base, publicGatewayUrl: "http://gateway.example.com" })
    ).toBeUndefined();
  });

  test("returns undefined when no signing key", () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(
        buildMcpConnectUrl({ ...base, publicGatewayUrl: "https://gateway.example.com" })
      ).toBeUndefined();
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });
});
