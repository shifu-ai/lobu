/**
 * SPA-side mirror of the backend's subdomain → org slug extraction.
 *
 * Keep the reserved-subdomain list in sync with `RESERVED_SUBDOMAINS` in
 * `packages/owletto-backend/src/index.ts` and the `extractSubdomainOrg` /
 * `getSubdomainZone` helpers in `packages/owletto-backend/src/utils/public-origin.ts`.
 *
 * Resolution order for the zone:
 *   1. `VITE_SUBDOMAIN_ZONE` (e.g. `lobu.ai`) — explicit override at build time.
 *   2. Hostname heuristic — strip the last two labels of `window.location.hostname`
 *      so deployments to `*.example.dev` keep working without a build flag.
 *   3. Localhost / IP literals → no subdomain.
 */

const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'mcp',
  'static',
  'assets',
  'cdn',
  'docs',
  'mail',
]);

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isIpLiteral(hostname: string): boolean {
  if (LOCALHOST_HOSTNAMES.has(hostname)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true;
  return false;
}

function getZoneFromHostname(hostname: string): string | null {
  if (isIpLiteral(hostname)) return null;
  const labels = hostname.split('.');
  if (labels.length < 3) return null;
  return labels.slice(-2).join('.');
}

export function getSubdomainZone(hostname?: string): string | null {
  const envZone = (import.meta.env.VITE_SUBDOMAIN_ZONE as string | undefined)?.trim();
  if (envZone) return envZone.replace(/^\./, '').toLowerCase();
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  if (!host) return null;
  return getZoneFromHostname(host.toLowerCase());
}

export function extractSubdomainOwner(hostname: string, zone: string | null): string | null {
  if (!zone) return null;
  const normalizedHost = hostname.split(':')[0]?.toLowerCase();
  if (!normalizedHost || !normalizedHost.endsWith(`.${zone}`)) return null;

  const sub = normalizedHost.slice(0, -(zone.length + 1));
  if (!sub || sub.includes('.') || RESERVED_SUBDOMAINS.has(sub)) return null;
  return sub;
}

let cached: string | null | undefined;

export function getSubdomainOwner(): string | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') {
    cached = null;
    return cached;
  }
  const hostname = window.location.hostname;
  cached = extractSubdomainOwner(hostname, getSubdomainZone(hostname));
  return cached;
}

export function __resetSubdomainCacheForTests(): void {
  cached = undefined;
}

/**
 * Builds the URL for an org's workspace home given the current host.
 * - On a per-org subdomain host, returns an absolute cross-host URL when the
 *   target slug differs (e.g. delivery.lobu.ai → https://acme.lobu.ai/).
 *   When the target matches the current subdomain, returns the in-app
 *   subdomain-stripped path "/".
 * - On any non-subdomain host (canonical app.lobu.ai, localhost,
 *   {sub}.example.dev with no zone), returns the in-app path "/{slug}".
 */
export function buildOwnerHref(targetSlug: string): { kind: 'spa'; to: string } | { kind: 'cross-host'; href: string } {
  if (typeof window === 'undefined') {
    return { kind: 'spa', to: `/${targetSlug}` };
  }
  const currentSubdomain = getSubdomainOwner();
  if (!currentSubdomain) {
    return { kind: 'spa', to: `/${targetSlug}` };
  }
  if (currentSubdomain === targetSlug) {
    return { kind: 'spa', to: '/' };
  }
  const zone = getSubdomainZone();
  if (!zone) {
    return { kind: 'spa', to: `/${targetSlug}` };
  }
  return { kind: 'cross-host', href: `${window.location.protocol}//${targetSlug}.${zone}/` };
}
