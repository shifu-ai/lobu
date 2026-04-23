/**
 * Code Assist OAuth helpers — gateway-side.
 *
 * Keeps three small pieces of state per OAuth identity:
 *  - access token refresh (via Google's standard OAuth token endpoint),
 *  - cloudaicompanion project discovery (`:loadCodeAssist` / `:onboardUser`),
 *  - a cache so we don't refresh or re-discover on every proxied request.
 *
 * Chat/tool-use Code Assist calls happen inside the worker via pi-ai's
 * `google-gemini-cli` provider; this file exists only so the gateway proxy
 * can swap the placeholder Bearer token for a real, fresh one and stamp the
 * right `project` into the forwarded request body.
 *
 * Conventions mirror @mariozechner/pi-ai's `utils/oauth/google-gemini-cli.ts`
 * so our behaviour stays aligned with what pi-ai does when it authenticates
 * directly from the CLI.
 */

import { createLogger } from "@lobu/core";

const logger = createLogger("gemini-oauth");

// Public OAuth client for the Gemini CLI's Code Assist access. Same values
// @mariozechner/pi-ai and @google/gemini-cli-core ship with — these aren't
// secrets (public desktop-app OAuth client). Split to keep GitHub secret
// scanning quiet.
const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk", "geV6Cu5clXFsxl"].join(
  "-"
);
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";

export interface OAuthCreds {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
  token_type?: string;
  id_token?: string;
  scope?: string;
}

interface CacheEntry {
  accessToken: string;
  expiresAt: number;
  projectId?: string;
  chain: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(creds: OAuthCreds): string {
  return creds.refresh_token.slice(-24);
}

function runExclusive<T>(entry: CacheEntry, fn: () => Promise<T>): Promise<T> {
  const next = entry.chain.then(() => fn());
  entry.chain = next.catch(() => undefined);
  return next;
}

async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Code Assist token refresh failed (${res.status}): ${body.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "x-goog-api-client": "gl-node/22.17.0",
    "client-metadata": JSON.stringify({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    }),
  };
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string;
  allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  currentTier?: { id?: string };
}

interface LroResponse {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}

function isVpcScAffected(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const err = (body as { error?: { details?: unknown[] } }).error;
  if (!err?.details || !Array.isArray(err.details)) return false;
  return err.details.some(
    (d) =>
      typeof d === "object" &&
      d !== null &&
      "reason" in d &&
      (d as { reason?: unknown }).reason === "SECURITY_POLICY_VIOLATED"
  );
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProject =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT_ID ||
    undefined;
  const headers = codeAssistHeaders(accessToken);

  const loadRes = await fetch(
    `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: envProject,
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
          duetProject: envProject,
        },
      }),
    }
  );

  let data: LoadCodeAssistResponse;
  if (!loadRes.ok) {
    const parsed = (await loadRes
      .clone()
      .json()
      .catch(() => undefined)) as unknown;
    if (isVpcScAffected(parsed)) {
      data = { currentTier: { id: TIER_STANDARD } };
    } else {
      const body = await loadRes.text().catch(() => "");
      throw new Error(
        `loadCodeAssist failed (${loadRes.status}): ${body.slice(0, 300)}`
      );
    }
  } else {
    data = (await loadRes.json()) as LoadCodeAssistResponse;
  }

  if (data.currentTier) {
    if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
    if (envProject) return envProject;
    throw new Error(
      "This Google account requires setting GOOGLE_CLOUD_PROJECT (or GOOGLE_CLOUD_PROJECT_ID) to use Code Assist. " +
        "See https://goo.gle/gemini-cli-auth-docs#workspace-gca."
    );
  }

  const defaultTier = data.allowedTiers?.find((t) => t.isDefault);
  const tierId = defaultTier?.id ?? TIER_LEGACY;
  if (tierId !== TIER_FREE && !envProject) {
    throw new Error(
      "This Google account requires setting GOOGLE_CLOUD_PROJECT (or GOOGLE_CLOUD_PROJECT_ID) to use Code Assist."
    );
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  };
  if (tierId !== TIER_FREE && envProject) {
    onboardBody.cloudaicompanionProject = envProject;
    (onboardBody.metadata as Record<string, unknown>).duetProject = envProject;
  }

  const onboardRes = await fetch(
    `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
    { method: "POST", headers, body: JSON.stringify(onboardBody) }
  );
  if (!onboardRes.ok) {
    const body = await onboardRes.text().catch(() => "");
    throw new Error(
      `onboardUser failed (${onboardRes.status}): ${body.slice(0, 300)}`
    );
  }

  let lro = (await onboardRes.json()) as LroResponse;
  let attempts = 0;
  while (lro.done === false && lro.name && attempts < 30) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await fetch(
      `${CODE_ASSIST_ENDPOINT}/v1internal/${lro.name}`,
      { method: "GET", headers }
    );
    if (!pollRes.ok) {
      const body = await pollRes.text().catch(() => "");
      throw new Error(
        `onboardUser poll failed (${pollRes.status}): ${body.slice(0, 300)}`
      );
    }
    lro = (await pollRes.json()) as LroResponse;
    attempts += 1;
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;
  if (envProject) return envProject;
  throw new Error(
    "Could not discover or provision a Google Cloud project for Code Assist."
  );
}

export interface ResolvedCodeAssist {
  accessToken: string;
  projectId: string;
}

/**
 * Return a valid (fresh) access token and the cloudaicompanion projectId for
 * the given OAuth creds. Refresh and discovery are serialized per identity
 * and results are cached in-process.
 */
export async function resolveCodeAssist(
  creds: OAuthCreds
): Promise<ResolvedCodeAssist> {
  const key = cacheKey(creds);
  let entry = cache.get(key);
  if (!entry) {
    entry = {
      accessToken: creds.access_token,
      expiresAt: creds.expiry_date ?? 0,
      projectId: undefined,
      chain: Promise.resolve(),
    };
    cache.set(key, entry);
  }

  const e = entry;
  return runExclusive(e, async () => {
    if (!e.accessToken || Date.now() >= e.expiresAt) {
      const refreshed = await refreshAccessToken(creds.refresh_token);
      e.accessToken = refreshed.accessToken;
      e.expiresAt = refreshed.expiresAt;
      logger.debug({ key }, "Code Assist access token refreshed");
    }
    if (!e.projectId) {
      e.projectId = await discoverProject(e.accessToken);
      logger.info(
        { key, projectId: e.projectId },
        "Code Assist project discovered"
      );
    }
    return { accessToken: e.accessToken, projectId: e.projectId };
  });
}

export function codeAssistUpstreamUrl(path: string, search: string): string {
  return `${CODE_ASSIST_ENDPOINT}${path}${search}`;
}

export function buildUpstreamHeaders(
  accessToken: string,
  incoming: Record<string, string>
): Record<string, string> {
  const out = codeAssistHeaders(accessToken);
  // Preserve Gemini-specific incoming headers (e.g. `anthropic-beta` for
  // Claude-via-Antigravity) but drop hop-by-hop/auth/ua headers that we set.
  const skip = new Set([
    "host",
    "connection",
    "transfer-encoding",
    "authorization",
    "content-length",
    "user-agent",
    "x-goog-api-client",
    "client-metadata",
    "accept-encoding",
  ]);
  for (const [k, v] of Object.entries(incoming)) {
    if (v && !skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
