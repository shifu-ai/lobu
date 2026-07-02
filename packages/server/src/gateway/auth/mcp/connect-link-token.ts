/**
 * Short-lived HMAC-signed tokens for the unauthenticated
 * `GET /mcp/oauth/start` connect link.
 *
 * The connect link is handed to end users (e.g. inside a LINE authorization
 * card) when a tool call fails with `not_connected` / `needs_reauth`, and is
 * opened directly in the user's browser — which has no PAT or session to
 * present. Trusting free-form `agentId`/`mcpId`/`userId` query params there
 * enables an OAuth account-binding CSRF: an attacker crafts a link pointing at
 * *their* agent, tricks a victim into authorizing with the victim's provider
 * account, and the credential lands in the attacker's scope.
 *
 * Instead, Lobu mints this token at the only place the binding is known to be
 * legitimate — inside the authenticated `tools/call` handler, *after* the
 * IDOR ownership check has passed — and `/mcp/oauth/start` accepts nothing
 * but the token. Possession of a validly-signed, unexpired token is the
 * proof that Lobu authorized this exact `(agentId, mcpId, userId, org)`
 * binding for an authenticated caller.
 *
 * Format: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))`.
 * The signing key is derived from the install's mandatory `ENCRYPTION_KEY`
 * (enforced at gateway boot — see `lobu/gateway.ts`) with a fixed purpose
 * string, so no new secret needs to be provisioned and the derived key is
 * never the raw ENCRYPTION_KEY itself.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ConnectLinkTokenPayload {
  v: 1;
  agentId: string;
  mcpId: string;
  userId: string;
  /** Tenant that minted the link — forwarded into startAuthCodeFlow so the credential is written into the right org scope. */
  organizationId?: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** Connect links are short-lived by design: 15 minutes. */
export const CONNECT_LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Domain-separation purpose string for the derived HMAC key. */
const KEY_PURPOSE = "lobu:mcp-oauth-connect-link:v1";

function deriveKey(): Buffer | null {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) return null;
  return createHmac("sha256", encryptionKey).update(KEY_PURPOSE).digest();
}

function signEncodedPayload(encodedPayload: string, key: Buffer): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

/**
 * Mint a signed connect-link token. Returns null (never throws) when no
 * signing key is available — callers omit the connectUrl rather than emit an
 * unsigned link.
 */
export function mintConnectLinkToken(params: {
  agentId: string;
  mcpId: string;
  userId: string;
  organizationId?: string;
  ttlMs?: number;
}): string | null {
  const key = deriveKey();
  if (!key) return null;

  const payload: ConnectLinkTokenPayload = {
    v: 1,
    agentId: params.agentId,
    mcpId: params.mcpId,
    userId: params.userId,
    ...(params.organizationId ? { organizationId: params.organizationId } : {}),
    exp: Date.now() + (params.ttlMs ?? CONNECT_LINK_TOKEN_TTL_MS),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${encoded}.${signEncodedPayload(encoded, key)}`;
}

/**
 * Verify a connect-link token: constant-time signature check, then shape and
 * expiry validation. Returns the payload, or null for anything invalid —
 * callers must respond with a single generic error, never distinguish why.
 */
export function verifyConnectLinkToken(
  token: string
): ConnectLinkTokenPayload | null {
  const key = deriveKey();
  if (!key) return null;

  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encodedPayload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);

  const expected = Buffer.from(signEncodedPayload(encodedPayload, key));
  const provided = Buffer.from(providedSignature);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.v !== 1) return null;
  if (typeof candidate.agentId !== "string" || !candidate.agentId) return null;
  if (typeof candidate.mcpId !== "string" || !candidate.mcpId) return null;
  if (typeof candidate.userId !== "string" || !candidate.userId) return null;
  if (
    candidate.organizationId !== undefined &&
    typeof candidate.organizationId !== "string"
  ) {
    return null;
  }
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) {
    return null;
  }
  if (candidate.exp <= Date.now()) return null;

  return {
    v: 1,
    agentId: candidate.agentId,
    mcpId: candidate.mcpId,
    userId: candidate.userId,
    ...(typeof candidate.organizationId === "string" &&
    candidate.organizationId
      ? { organizationId: candidate.organizationId }
      : {}),
    exp: candidate.exp,
  };
}
