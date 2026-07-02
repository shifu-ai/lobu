/**
 * Public callback endpoint for MCP OAuth 2.1 authorization-code flows.
 *
 * After the user approves the app in the authorization server's UI, the
 * provider redirects here with `?code=…&state=…`. We validate & consume the
 * state (GETDEL, so replay fails), exchange the code for tokens using the
 * stored PKCE verifier, and render a simple "you can close this tab" page.
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import {
  completeAuthCodeFlow,
  startAuthCodeFlow,
} from "../../auth/mcp/oauth-flow.js";
import { postOAuthCompletionPrompt } from "../../auth/mcp/resume-after-oauth.js";
import { verifyConnectLinkToken } from "../../auth/mcp/connect-link-token.js";
import { escapeHtml } from "../../../utils/html.js";
import { getClientIP, getRateLimiter } from "../../../utils/rate-limiter.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { CoreServices } from "../../platform.js";
import type { WritableSecretStore } from "../../secrets/index.js";

const logger = createLogger("mcp-oauth-callback");

interface McpOAuthRoutesConfig {
  secretStore: WritableSecretStore;
  /** Absolute URL mounted on the gateway — used as redirect_uri verbatim. */
  publicGatewayUrl: string;
  /**
   * Optional — when provided, on a successful callback we enqueue a synthetic
   * "you connected X" follow-up so the agent proactively retries the original
   * request instead of making the user type again.
   */
  coreServices?: CoreServices;
  chatInstanceManager?: ChatInstanceManager;
}

function renderResultPage(opts: {
  success: boolean;
  title: string;
  body: string;
}): string {
  const color = opts.success ? "#16a34a" : "#dc2626";
  const safeTitle = escapeHtml(opts.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
    .card { max-width: 440px; padding: 32px; background: white;
            border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            text-align: center; }
    h1 { color: ${color}; margin: 0 0 12px; font-size: 20px; }
    p  { color: #475569; margin: 4px 0; line-height: 1.5; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    ${opts.body}
  </div>
</body>
</html>`;
}

export function createMcpOAuthRoutes(config: McpOAuthRoutesConfig): Hono {
  const {
    secretStore,
    publicGatewayUrl,
    coreServices,
    chatInstanceManager,
  } = config;
  const router = new Hono();

  const redirectUri = `${publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;

  router.get("/mcp/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    const errorDescription = c.req.query("error_description");

    if (error) {
      logger.warn("OAuth provider returned error to callback", {
        error,
        errorDescription,
      });
      const safeError = escapeHtml(error);
      const safeErrorDescription = errorDescription
        ? escapeHtml(errorDescription)
        : "Please try again from the chat.";
      return c.html(
        renderResultPage({
          success: false,
          title: "Authorization failed",
          body: `<p>The provider returned <span class="mono">${safeError}</span>.</p>
                 <p>${safeErrorDescription}</p>`,
        }),
        400
      );
    }

    if (!code || !state) {
      return c.html(
        renderResultPage({
          success: false,
          title: "Missing code or state",
          body: `<p>This callback URL was opened without a valid authorization response.</p>`,
        }),
        400
      );
    }

    try {
      const result = await completeAuthCodeFlow({
        secretStore,
        state,
        code,
        redirectUri,
      });

      logger.info("Stored MCP OAuth credential via callback", {
        mcpId: result.mcpId,
        agentId: result.agentId,
        scopeKey: result.scopeKey,
        platform: result.platform,
      });

      // Proactively resume the agent in the original thread so the user
      // doesn't have to retype. Best-effort — if the injection fails (no
      // coreServices, missing provider, queue unavailable), the credential
      // is still stored and the user can send a follow-up message manually.
      if (coreServices && result.resumeMode !== "none") {
        try {
          await postOAuthCompletionPrompt({
            coreServices,
            chatInstanceManager,
            agentId: result.agentId,
            platform: result.platform,
            userId: result.userId,
            channelId: result.channelId,
            conversationId: result.conversationId,
            teamId: result.teamId,
            connectionId: result.connectionId,
            mcpId: result.mcpId,
            scope: result.scope,
          });
        } catch (err) {
          logger.warn("Failed to enqueue OAuth resume prompt", {
            mcpId: result.mcpId,
            agentId: result.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const safeMcpId = escapeHtml(result.mcpId);
      const scopeLabel = result.scopeKey.startsWith("channel-")
        ? "channel"
        : "user";
      return c.html(
        renderResultPage({
          success: true,
          title: `Connected ${result.mcpId}`,
          body: `<p>You can close this tab and return to the chat.</p>
                 <p>Signed in as <span class="mono">${safeMcpId}</span> for this ${scopeLabel}.</p>`,
        })
      );
    } catch (err) {
      logger.error("Failed to complete MCP OAuth flow", {
        error: err instanceof Error ? err.message : String(err),
      });
      const safeMessage = escapeHtml(
        err instanceof Error ? err.message : "Unknown error"
      );
      return c.html(
        renderResultPage({
          success: false,
          title: "Authorization failed",
          body: `<p>${safeMessage}</p>
                 <p>Please try again from the chat.</p>`,
        }),
        500
      );
    }
  });

  /**
   * Directly-clickable entry point for `connectUrl` links handed to end
   * users (e.g. a LINE authorization card) when a tool call fails with
   * `not_connected` / `needs_reauth`. Unlike the admin-PAT-gated
   * `POST /api/provisioning/agents/:agentId/mcp/:mcpId/oauth/start`, this is
   * unauthenticated by design — it's opened directly in the user's browser,
   * which has no PAT to present.
   *
   * The route accepts nothing but a short-lived HMAC-signed `token` minted by
   * the authenticated tools/call handler (see
   * `lobu/agent-routes.ts#buildToolCallConnectUrl` and
   * `gateway/auth/mcp/connect-link-token.ts`). `agentId`/`mcpId`/`userId`/
   * `organizationId` come exclusively from the verified token payload —
   * free-form query params are ignored. This closes the OAuth account-binding
   * CSRF where an attacker hands a victim a link targeting the attacker's
   * agent: the attacker cannot mint a valid token for a binding Lobu never
   * authorized, and tampering with the payload breaks the signature.
   *
   * All rejection paths (missing/forged/tampered/expired token, unresolvable
   * connector) intentionally return the same generic message so the endpoint
   * cannot be used as an enumeration oracle.
   */
  const connectLinkInvalidPage = () =>
    renderResultPage({
      success: false,
      title: "Connect link invalid",
      body: `<p>This connect link is invalid or has expired. Please request a new one.</p>`,
    });

  router.get("/mcp/oauth/start", async (c) => {
    // Basic per-IP throttle: this is an unauthenticated endpoint whose only
    // cost is HMAC verification + a config lookup, but keep brute-force and
    // scanning noise down. Same opt-out knob as the other public limiters.
    if (process.env.RATE_LIMIT_ENABLED !== "false") {
      const rateLimit = getRateLimiter().checkLimit(
        `rate:mcp-oauth-start:${getClientIP(c.req.raw)}`,
        {
          limit: 30,
          windowSeconds: 60,
          errorMessage: "Too many requests. Please wait a moment and retry.",
        }
      );
      if (!rateLimit.allowed) {
        return c.html(
          renderResultPage({
            success: false,
            title: "Too many requests",
            body: `<p>Please wait a moment and open the link again.</p>`,
          }),
          429
        );
      }
    }

    const token = c.req.query("token")?.trim();
    const payload = token ? verifyConnectLinkToken(token) : null;
    if (!payload) {
      return c.html(connectLinkInvalidPage(), 400);
    }
    // Binding comes exclusively from the verified token payload; any other
    // query params (e.g. a stray attacker-appended agentId) are ignored.
    const { agentId, mcpId, userId, organizationId } = payload;

    const mcpConfigService = coreServices?.getMcpConfigService?.();
    const httpServer = await mcpConfigService?.getHttpServer?.(mcpId, agentId);
    if (!httpServer) {
      return c.html(connectLinkInvalidPage(), 404);
    }

    try {
      const { authorizationUrl } = await startAuthCodeFlow({
        secretStore,
        mcpId,
        upstreamUrl: httpServer.upstreamUrl,
        agentId,
        userId,
        scopeKey: userId,
        wwwAuthenticate: null,
        redirectUri,
        staticOauth: httpServer.oauth,
        platform: "toolbox-line",
        channelId: "",
        conversationId: "",
        resumeMode: "none",
        organizationId,
      });
      return c.redirect(authorizationUrl, 302);
    } catch (err) {
      logger.error("Failed to start MCP OAuth flow from connect link", {
        mcpId,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      const safeMessage = escapeHtml(
        err instanceof Error ? err.message : "Unknown error"
      );
      return c.html(
        renderResultPage({
          success: false,
          title: "Authorization failed",
          body: `<p>${safeMessage}</p>
                 <p>Please try again from the chat.</p>`,
        }),
        500
      );
    }
  });

  logger.debug("MCP OAuth callback route registered at /mcp/oauth/callback");
  logger.debug("MCP OAuth start route registered at /mcp/oauth/start");
  return router;
}
