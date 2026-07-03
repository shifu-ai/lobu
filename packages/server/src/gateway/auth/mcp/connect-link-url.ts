/**
 * Shared builder for the directly-clickable `GET /mcp/oauth/start?token=...`
 * connect URL. Used by (1) the tools/call not_connected/needs_reauth path
 * (`lobu/agent-routes.ts`, T12) and (2) the `/internal/device-auth/start`
 * auth-code fallback when the upstream does not support the device-code
 * grant.
 *
 * Best-effort: returns undefined (never throws) when `publicGatewayUrl` isn't
 * configured or isn't https, or when no signing key is available — callers
 * must omit/degrade rather than fail the request over a missing link.
 */
import { createLogger } from "@lobu/core";
import { mintConnectLinkToken } from "./connect-link-token.js";

const logger = createLogger("mcp-connect-link");

export function buildMcpConnectUrl(params: {
  publicGatewayUrl: string | undefined;
  agentId: string;
  mcpId: string;
  userId: string;
  organizationId?: string;
  /** Log prefix identifying the caller, e.g. "tools/call" or "device-auth". */
  logContext?: string;
}): string | undefined {
  const ctx = params.logContext ?? "connect-link";
  if (!params.publicGatewayUrl || typeof params.publicGatewayUrl !== "string") {
    logger.warn(`[${ctx}] connectUrl omitted: publicGatewayUrl not configured`, {
      mcpId: params.mcpId,
    });
    return undefined;
  }
  try {
    const base = params.publicGatewayUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/mcp/oauth/start`);
    if (url.protocol !== "https:") {
      logger.warn(`[${ctx}] connectUrl omitted: publicGatewayUrl is not https`, {
        mcpId: params.mcpId,
      });
      return undefined;
    }
    const token = mintConnectLinkToken({
      agentId: params.agentId,
      mcpId: params.mcpId,
      userId: params.userId,
      organizationId: params.organizationId,
    });
    if (!token) {
      logger.warn(`[${ctx}] connectUrl omitted: no signing key (ENCRYPTION_KEY unset)`, {
        mcpId: params.mcpId,
      });
      return undefined;
    }
    url.searchParams.set("token", token);
    return url.toString();
  } catch (error) {
    logger.warn(`[${ctx}] connectUrl omitted: failed to build URL`, {
      mcpId: params.mcpId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
