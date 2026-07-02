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

const postOAuthCompletionPromptMock = mock(async () => undefined);

mock.module("../../auth/mcp/oauth-flow.js", () => ({
  completeAuthCodeFlow: completeAuthCodeFlowMock,
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
