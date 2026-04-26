import { getSubdomainOwner } from '../subdomain';
import { parseEntityPath } from '../url';

export const DEFAULT_API_URL =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
export const API_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL;

export async function getApiErrorMessage(response: Response): Promise<string> {
  const fallback = `API error: ${response.status}`;
  const raw = await response.text();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
    return fallback;
  } catch {
    return raw;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number }
) {
  const timeoutMs = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export type ApiOrgContext = {
  organizationId?: string | null;
  slug?: string | null;
};

export function normalizeOrgContext(orgContext?: ApiOrgContext | string | null): {
  organizationId: string | null;
  slug: string | null;
} {
  if (typeof orgContext === 'string') {
    return { organizationId: orgContext, slug: null };
  }
  return {
    organizationId: orgContext?.organizationId ?? null,
    slug: orgContext?.slug ?? null,
  };
}

export function getPathScope(): { slug: string | null } {
  if (typeof window === 'undefined') {
    return { slug: null };
  }
  const parsed = parseEntityPath(window.location.pathname);
  if (parsed.owner && !parsed.ownerInfo?.isUser) {
    return { slug: parsed.owner };
  }
  // On per-org subdomains the owner segment is stripped from the URL bar by
  // the SPA's subdomain-history adapter, so fall back to the subdomain.
  const subdomainOwner = getSubdomainOwner();
  return { slug: subdomainOwner };
}

export function resolveApiScope(orgContext?: string | ApiOrgContext): {
  slug: string;
} {
  const pathScope = getPathScope();

  if (typeof orgContext === 'string' && orgContext) {
    return { slug: orgContext };
  }

  if (orgContext && typeof orgContext !== 'string' && orgContext.slug) {
    return { slug: orgContext.slug };
  }

  if (pathScope.slug) {
    return pathScope as { slug: string };
  }

  throw new Error('Organization slug is required in URL scope');
}

export function resolveOrgSelector(ctx: { organizationId?: string | null; slug?: string | null }) {
  if (ctx.organizationId) {
    const pathScope = getPathScope();
    if (pathScope.slug) {
      return { slug: pathScope.slug };
    }
  }
  if (ctx.slug) {
    return { slug: ctx.slug };
  }
  throw new Error('Organization context required');
}

export async function apiCall<T>(
  endpoint: string,
  body: Record<string, unknown>,
  orgContext?: string | ApiOrgContext
): Promise<T> {
  const scope = resolveApiScope(orgContext);
  const response = await fetchWithTimeout(`${API_URL}/api/${scope.slug}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const rawBody = await response.text();
    let message = `API error: ${response.status}`;

    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody) as { error?: string; message?: string };
        message = parsed.message || parsed.error || message;
      } catch {
        message = rawBody;
      }
    }

    throw new Error(message);
  }

  return response.json();
}
