import { describe, expect, mock, test } from "bun:test";

// The connect-link token signing key is derived from ENCRYPTION_KEY; pin a
// deterministic canonical 32-byte key (hex) so other suites sharing the
// process see a valid key too.
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const completeAuthCodeFlowMock = mock(async () => ({
  mcpId: "shifu-toolbox",
  agentId: "shifu-u-oauth-none",
  userId: "toolbox-user-1",
  scopeKey: "toolbox-user-1",
  platform: "toolbox-web",
  channelId: "",
  conversationId: "",
  resumeMode: "none" as const,
}));

const startAuthCodeFlowMock = mock(async () => ({
  authorizationUrl: "https://idp.example.test/authorize?state=test-state",
  state: "test-state",
}));

const postOAuthCompletionPromptMock = mock(async () => undefined);

mock.module("../../auth/mcp/oauth-flow.js", () => ({
  completeAuthCodeFlow: completeAuthCodeFlowMock,
  startAuthCodeFlow: startAuthCodeFlowMock,
}));

mock.module("../../auth/mcp/resume-after-oauth.js", () => ({
  postOAuthCompletionPrompt: postOAuthCompletionPromptMock,
}));

describe("mcp oauth callback route", () => {
  test("escapes reflected error and error_description to prevent XSS", async () => {
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.com",
    });

    const maliciousError = '"><script>alert(1)</script>';
    const maliciousDescription = '<script>alert("xss")</script>';
    const url =
      "https://gateway.example.com/mcp/oauth/callback" +
      `?error=${encodeURIComponent(maliciousError)}` +
      `&error_description=${encodeURIComponent(maliciousDescription)}`;

    const res = await router.request(url);

    expect(res.status).toBe(400);
    const html = await res.text();

    expect(html).not.toContain(maliciousError);
    expect(html).not.toContain(maliciousDescription);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
    );
  });

  test("does not enqueue a resume prompt when resumeMode is none", async () => {
    completeAuthCodeFlowMock.mockClear();
    postOAuthCompletionPromptMock.mockClear();

    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: {} as any,
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/callback?code=ok&state=state-ok"
    );

    expect(response.status).toBe(200);
    expect(completeAuthCodeFlowMock).toHaveBeenCalledTimes(1);
    expect(postOAuthCompletionPromptMock).not.toHaveBeenCalled();
  });
});

describe("mcp oauth start route (connectUrl destination)", () => {
  function fakeCoreServices(opts: {
    httpServer?: { upstreamUrl: string } | undefined;
  }) {
    return {
      getMcpConfigService: () => ({
        getHttpServer: async () => opts.httpServer,
      }),
    } as any;
  }

  async function mintToken(overrides: Record<string, unknown> = {}) {
    const { mintConnectLinkToken } = await import(
      "../../auth/mcp/connect-link-token.js"
    );
    return mintConnectLinkToken({
      agentId: "agent-1",
      mcpId: "notion",
      userId: "real-owner",
      organizationId: "org-1",
      ...overrides,
    })!;
  }

  async function buildRouter(opts: {
    httpServer?: { upstreamUrl: string } | undefined;
  }) {
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    return createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: fakeCoreServices(opts),
    });
  }

  const GENERIC_INVALID_MESSAGE =
    "This connect link is invalid or has expired";

  test("400s with a generic message when no token is provided (legacy free-form params are rejected)", async () => {
    startAuthCodeFlowMock.mockClear();
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/start?agentId=agent-1&mcpId=notion&userId=real-owner"
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(GENERIC_INVALID_MESSAGE);
    expect(startAuthCodeFlowMock).not.toHaveBeenCalled();
  });

  test("400s on a forged token signed with a different secret", async () => {
    startAuthCodeFlowMock.mockClear();
    const { createHmac } = await import("node:crypto");
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        agentId: "attacker-agent",
        mcpId: "notion",
        userId: "attacker",
        exp: Date.now() + 60_000,
      })
    ).toString("base64url");
    const forgedSig = createHmac("sha256", "not-the-real-secret")
      .update(payload)
      .digest("base64url");
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${payload}.${forgedSig}`
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(GENERIC_INVALID_MESSAGE);
    expect(startAuthCodeFlowMock).not.toHaveBeenCalled();
  });

  test("400s on a tampered token whose payload was re-targeted after signing", async () => {
    startAuthCodeFlowMock.mockClear();
    const token = await mintToken();
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        agentId: "attacker-agent",
        mcpId: "notion",
        userId: "victim",
        exp: Date.now() + 60_000,
      })
    ).toString("base64url");
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${tamperedPayload}.${signature}`
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(GENERIC_INVALID_MESSAGE);
    expect(startAuthCodeFlowMock).not.toHaveBeenCalled();
  });

  test("400s on an expired token", async () => {
    startAuthCodeFlowMock.mockClear();
    const token = await mintToken({ ttlMs: -1_000 });
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${encodeURIComponent(token)}`
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(GENERIC_INVALID_MESSAGE);
    expect(startAuthCodeFlowMock).not.toHaveBeenCalled();
  });

  test("404s with the same generic message when the connector has no resolvable http server config", async () => {
    const token = await mintToken();
    const router = await buildRouter({ httpServer: undefined });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${encodeURIComponent(token)}`
    );

    expect(response.status).toBe(404);
    // Same body as the invalid-token page — no enumeration side channel
    // between "unknown binding" and "known but unconfigured connector".
    expect(await response.text()).toContain(GENERIC_INVALID_MESSAGE);
  });

  test("redirects to the real authorization URL on a valid token, binding the flow to the token payload", async () => {
    startAuthCodeFlowMock.mockClear();
    const token = await mintToken();
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.test/authorize?state=test-state"
    );
    expect(startAuthCodeFlowMock).toHaveBeenCalledTimes(1);
    const callArgs = (startAuthCodeFlowMock.mock.calls[0] as unknown[])[0];
    expect(callArgs).toMatchObject({
      agentId: "agent-1",
      mcpId: "notion",
      userId: "real-owner",
      scopeKey: "real-owner",
      organizationId: "org-1",
    });
  });

  test("attack scenario: extra free-form query params are ignored — only the token payload binds the flow", async () => {
    startAuthCodeFlowMock.mockClear();
    const token = await mintToken();
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    const response = await router.request(
      `https://gateway.example.test/mcp/oauth/start?token=${encodeURIComponent(token)}` +
        `&agentId=attacker-agent&userId=attacker&mcpId=github`,
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(startAuthCodeFlowMock).toHaveBeenCalledTimes(1);
    const callArgs = (startAuthCodeFlowMock.mock.calls[0] as unknown[])[0];
    expect(callArgs).toMatchObject({
      agentId: "agent-1",
      mcpId: "notion",
      userId: "real-owner",
    });
  });

  test("throttles repeated requests per IP with a 429", async () => {
    const router = await buildRouter({
      httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
    });

    let sawTooManyRequests = false;
    for (let i = 0; i < 40; i++) {
      const response = await router.request(
        "https://gateway.example.test/mcp/oauth/start?token=bogus",
        { headers: { "x-forwarded-for": "203.0.113.77" } }
      );
      if (response.status === 429) {
        sawTooManyRequests = true;
        break;
      }
      expect(response.status).toBe(400);
    }

    expect(sawTooManyRequests).toBe(true);
  });
});
