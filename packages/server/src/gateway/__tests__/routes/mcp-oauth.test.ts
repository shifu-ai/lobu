import { describe, expect, mock, test } from "bun:test";

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
    owner?: { userId: string } | null;
    httpServer?: { upstreamUrl: string } | undefined;
  }) {
    return {
      getAgentMetadataStore: () => ({
        getMetadata: async () =>
          opts.owner === null
            ? null
            : { agentId: "agent-1", owner: opts.owner, createdAt: Date.now() },
      }),
      getMcpConfigService: () => ({
        getHttpServer: async () => opts.httpServer,
      }),
    } as any;
  }

  test("400s when required query params are missing", async () => {
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: fakeCoreServices({}),
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/start?agentId=agent-1"
    );

    expect(response.status).toBe(400);
  });

  test("404s when the caller's userId does not match the agent's recorded owner", async () => {
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: fakeCoreServices({ owner: { userId: "real-owner" } }),
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/start?agentId=agent-1&mcpId=notion&userId=intruder"
    );

    expect(response.status).toBe(404);
  });

  test("404s when the connector has no resolvable http server config", async () => {
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: fakeCoreServices({
        owner: { userId: "real-owner" },
        httpServer: undefined,
      }),
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/start?agentId=agent-1&mcpId=notion&userId=real-owner"
    );

    expect(response.status).toBe(404);
  });

  test("redirects to the real authorization URL on success", async () => {
    startAuthCodeFlowMock.mockClear();
    const { createMcpOAuthRoutes } = await import(
      "../../routes/public/mcp-oauth.js"
    );
    const router = createMcpOAuthRoutes({
      secretStore: {} as any,
      publicGatewayUrl: "https://gateway.example.test",
      coreServices: fakeCoreServices({
        owner: { userId: "real-owner" },
        httpServer: { upstreamUrl: "https://mcp.upstream.test/notion" },
      }),
    });

    const response = await router.request(
      "https://gateway.example.test/mcp/oauth/start?agentId=agent-1&mcpId=notion&userId=real-owner",
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://idp.example.test/authorize?state=test-state"
    );
    expect(startAuthCodeFlowMock).toHaveBeenCalledTimes(1);
  });
});
