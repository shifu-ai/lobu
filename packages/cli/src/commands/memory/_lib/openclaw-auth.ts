import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { getToken } from "../../../internal/index.js";

export interface MemorySession {
  mcpUrl: string;
  org?: string;
  tokenType?: string;
  updatedAt?: string;
}

interface MemoryPreferences {
  version: 1;
  mcpUrl?: string;
  activeOrg?: string;
}

const DEFAULT_MCP_URL = "https://lobu.ai/mcp";
const DEFAULT_STORE_PATH = resolve(homedir(), ".config", "lobu", "memory.json");

function defaultPreferences(): MemoryPreferences {
  return { version: 1 };
}

export function normalizeMcpUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/mcp";
  } else if (!url.pathname.startsWith("/mcp")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/mcp`;
  }
  return url.toString().replace(/\/+$/, "");
}

/** Strip org suffix from an MCP URL for server-level defaults: /mcp/acme → /mcp */
export function baseMcpUrl(input: string): string {
  const url = new URL(normalizeMcpUrl(input));
  url.hash = "";
  url.search = "";
  url.pathname = "/mcp";
  return url.toString().replace(/\/+$/, "");
}

/** Build an org-scoped MCP URL: `https://host/mcp/{org}` */
export function mcpUrlForOrg(baseUrl: string, org: string): string {
  const url = new URL(normalizeMcpUrl(baseUrl));
  url.pathname = `/mcp/${org}`;
  return url.toString().replace(/\/+$/, "");
}

/** Extract org slug from a /mcp/{org} URL, or null if bare /mcp */
export function orgFromMcpUrl(mcpUrl: string): string | null {
  try {
    const { pathname } = new URL(mcpUrl);
    const match = pathname.match(/^\/mcp\/([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function getMemoryPreferencesPath(customPath?: string): string {
  return customPath ? resolve(customPath) : DEFAULT_STORE_PATH;
}

function loadMemoryPreferences(storePath?: string): MemoryPreferences {
  const path = getMemoryPreferencesPath(storePath);
  if (!existsSync(path)) return defaultPreferences();
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8")
    ) as Partial<MemoryPreferences>;
    return {
      version: 1,
      mcpUrl:
        typeof parsed.mcpUrl === "string"
          ? normalizeMcpUrl(parsed.mcpUrl)
          : undefined,
      activeOrg:
        typeof parsed.activeOrg === "string" ? parsed.activeOrg : undefined,
    };
  } catch {
    return defaultPreferences();
  }
}

function saveMemoryPreferences(store: MemoryPreferences, storePath?: string) {
  const path = getMemoryPreferencesPath(storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function validateOrgSlug(orgSlug: string) {
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i.test(orgSlug)) {
    throw new Error(
      `Invalid organization slug "${orgSlug}". Slugs may only contain alphanumeric characters, hyphens, and underscores.`
    );
  }
}

export function setActiveOrg(orgSlug: string, storePath?: string) {
  validateOrgSlug(orgSlug);
  const store = loadMemoryPreferences(storePath);
  store.activeOrg = orgSlug;
  saveMemoryPreferences(store, storePath);
}

export function setActiveMcpUrl(mcpUrl: string, storePath?: string) {
  const store = loadMemoryPreferences(storePath);
  store.mcpUrl = baseMcpUrl(mcpUrl);
  saveMemoryPreferences(store, storePath);
}

export function getActiveSession(storePath?: string): {
  session: MemorySession | null;
  key: string | null;
  path: string;
} {
  const path = getMemoryPreferencesPath(storePath);
  const base = resolveServerUrl(undefined, storePath) ?? DEFAULT_MCP_URL;
  const org = resolveOrg(undefined, undefined, storePath);
  const key = org ? mcpUrlForOrg(base, org) : base;
  return {
    session: {
      mcpUrl: key,
      org,
      tokenType: "Bearer",
      updatedAt: new Date().toISOString(),
    },
    key,
    path,
  };
}

export function getSessionForOrg(
  orgSlug: string,
  storePath?: string,
  urlFlag?: string
): { session: MemorySession; key: string; path: string } | null {
  validateOrgSlug(orgSlug);
  const path = getMemoryPreferencesPath(storePath);
  const base = resolveServerUrl(urlFlag, storePath) ?? DEFAULT_MCP_URL;
  const key = mcpUrlForOrg(base, orgSlug);
  return {
    session: {
      mcpUrl: key,
      org: orgSlug,
      tokenType: "Bearer",
      updatedAt: new Date().toISOString(),
    },
    key,
    path,
  };
}

/**
 * Resolve which server URL to use.
 * Priority: explicit url arg > LOBU_MEMORY_URL > local preference > cloud default.
 */
export function resolveServerUrl(
  urlFlag?: string,
  storePath?: string
): string | null {
  if (urlFlag) return normalizeMcpUrl(urlFlag);
  if (process.env.LOBU_MEMORY_URL)
    return normalizeMcpUrl(process.env.LOBU_MEMORY_URL);
  const prefs = loadMemoryPreferences(storePath);
  return prefs.mcpUrl ?? DEFAULT_MCP_URL;
}

/**
 * Resolve which org to use.
 * Priority: explicit org arg > LOBU_MEMORY_ORG > session > local preference.
 */
export function resolveOrg(
  orgFlag?: string,
  session?: MemorySession | null,
  storePath?: string
): string | undefined {
  if (orgFlag) return orgFlag;
  if (process.env.LOBU_MEMORY_ORG) return process.env.LOBU_MEMORY_ORG;
  if (session?.org) return session.org;
  return loadMemoryPreferences(storePath).activeOrg;
}

/**
 * Resolve a usable bearer token from top-level `lobu login` credentials.
 */
export async function getUsableToken(
  mcpUrl?: string,
  storePath?: string
): Promise<{
  token: string;
  session: MemorySession;
  storePath: string;
} | null> {
  const token = await getToken();
  if (!token) return null;

  const resolvedUrl = mcpUrl
    ? normalizeMcpUrl(mcpUrl)
    : (resolveServerUrl(undefined, storePath) ?? DEFAULT_MCP_URL);
  const org =
    orgFromMcpUrl(resolvedUrl) ?? resolveOrg(undefined, undefined, storePath);
  const sessionUrl =
    org && !orgFromMcpUrl(resolvedUrl)
      ? mcpUrlForOrg(resolvedUrl, org)
      : resolvedUrl;

  return {
    token,
    session: {
      mcpUrl: sessionUrl,
      org,
      tokenType: "Bearer",
      updatedAt: new Date().toISOString(),
    },
    storePath: getMemoryPreferencesPath(storePath),
  };
}
