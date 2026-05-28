import { verifyWorkerToken } from "@lobu/core";
import type { Context, Next } from "hono";
import { verifySettingsSession } from "../routes/public/settings-auth.js";
import type { ExternalAuthClient } from "./external/client.js";
import { getRevokedTokenStore } from "./revoked-token-store.js";

export const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Caller identity surfaced to handlers via `c.get("authContext")` after a
 * successful auth check. `organizationId` is the token-bound or personal-org
 * id when the auth path can resolve one (worker token payload, or
 * `/oauth/userinfo` org slug); otherwise undefined. `createAgent` uses it to
 * stamp the worker token for ephemeral agents so the cross-pod conversation
 * lock can be acquired (#1068).
 */
export interface ApiAuthContext {
  userId?: string;
  organizationId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    authContext?: ApiAuthContext;
  }
}

/**
 * Creates a Hono middleware that enforces the standard auth check:
 *   1. Settings session cookie  2. Worker token (local)  3. External OAuth
 *
 * The worker-token check is local + cheap, so it runs before the remote OIDC
 * userinfo fetch — a valid worker token never needs to round-trip to the
 * identity provider.
 */
export function createApiAuthMiddleware(opts: {
  externalAuthClient?: ExternalAuthClient;
  allowWorkerToken?: boolean;
  allowSettingsSession?: boolean;
}) {
  const revokedTokens = getRevokedTokenStore();

  return async (c: Context, next: Next) => {
    // 1. Try settings session cookie when explicitly allowed.
    // verifySettingsSession now enforces jti revocation internally.
    if (opts.allowSettingsSession) {
      const session = await verifySettingsSession(c);
      if (session) {
        c.set("authContext", { userId: session.userId } satisfies ApiAuthContext);
        return next();
      }
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const token = authHeader.substring(7);

    // 2. Try worker token when explicitly allowed for the route (local check).
    if (opts.allowWorkerToken !== false) {
      const workerData = verifyWorkerToken(token);
      if (workerData) {
        const tokenAge = Date.now() - workerData.timestamp;
        if (tokenAge <= TOKEN_EXPIRATION_MS) {
          if (workerData.jti && (await revokedTokens.isRevoked(workerData.jti))) {
            return c.json({ success: false, error: "Unauthorized" }, 401);
          }
          c.set("authContext", {
            userId: workerData.userId,
            organizationId: workerData.organizationId,
          } satisfies ApiAuthContext);
          return next();
        }
      }
    }

    // 3. Try external OAuth token (validated against MEMORY_URL userinfo).
    if (opts.externalAuthClient) {
      try {
        const userInfo = await opts.externalAuthClient.fetchUserInfo(token);
        if (userInfo?.sub) {
          c.set("authContext", {
            userId: userInfo.sub,
            organizationId: userInfo.organizationId,
          } satisfies ApiAuthContext);
          return next();
        }
      } catch {
        // Token not valid for external auth, continue to next method
      }
    }

    return c.json({ success: false, error: "Unauthorized" }, 401);
  };
}
