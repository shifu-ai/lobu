import { RESERVED_PATHS } from './reserved';

/**
 * Validates a redirect URL to prevent open-redirect attacks.
 * Returns the URL only if it is a safe relative path or same-origin absolute URL.
 * Falls back to `fallback` (default "/") otherwise.
 */
export function sanitizeRedirectUrl(url: string | undefined | null, fallback = '/'): string {
  if (!url || typeof url !== 'string') return fallback;

  const trimmed = url.trim();
  if (trimmed.length === 0) return fallback;

  // Block protocol-relative URLs (e.g. "//evil.com")
  if (trimmed.startsWith('//')) return fallback;

  // Allow relative paths starting with /
  if (trimmed.startsWith('/')) return trimmed;

  // Allow same-origin absolute URLs
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin === window.location.origin) return trimmed;
  } catch {
    // Not a valid absolute URL — reject
  }

  return fallback;
}

/**
 * Validates an OAuth redirect URL from server responses.
 * Ensures the URL uses http(s) and is not a javascript: or data: URI.
 * Returns null if the URL is missing or invalid.
 */
export function validateOAuthRedirectUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
  } catch {
    // Not a valid URL
  }

  return null;
}

export interface EntityPathSegment {
  entity_type: string;
  slug: string;
}

// Owner can be @username (user namespace) or org-slug (organization)
export interface ParsedOwner {
  isUser: boolean;
  slug: string; // without @ prefix
  raw: string; // as it appears in URL (with @ for users)
}

export function parseOwner(owner: string): ParsedOwner {
  const isUser = owner.startsWith('@');
  return {
    isUser,
    slug: isUser ? owner.slice(1) : owner,
    raw: owner,
  };
}

export function normalizePath(path: string): string {
  const cleaned = path.split('?')[0]?.split('#')[0] ?? path;
  return `/${cleaned.replace(/^\/+|\/+$/g, '')}`;
}

export function buildOwnerRootPath(owner: string | null | undefined): string {
  if (!owner) return '';
  return normalizePath(owner.startsWith('/') ? owner : `/${owner}`);
}

function encodeEntityType(entityType: string): string {
  // Encode leading $ as %24 to prevent TanStack Router from interpreting it as a route param
  return entityType.startsWith('$') ? `%24${entityType.slice(1)}` : entityType;
}

export function buildEntityPath(segments: EntityPathSegment[]): string {
  return segments
    .map((segment) => `${encodeEntityType(segment.entity_type)}/${segment.slug}`)
    .join('/');
}

export function buildEntityUrl(owner: string, segments: EntityPathSegment[]): string {
  const suffix = buildEntityPath(segments);
  return suffix ? `/${owner}/${suffix}` : `/${owner}`;
}

export function parseEntityPath(path: string): {
  owner: string | null;
  ownerInfo: ParsedOwner | null;
  segments: EntityPathSegment[];
  isValid: boolean;
} {
  const normalized = normalizePath(path);
  const parts = normalized
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

  if (parts.length === 0) {
    return { owner: null, ownerInfo: null, segments: [], isValid: false };
  }

  const owner = parts[0];
  if (!owner) {
    return { owner: null, ownerInfo: null, segments: [], isValid: false };
  }
  if (RESERVED_PATHS.includes(owner.replace(/^@/, ''))) {
    return { owner: null, ownerInfo: null, segments: [], isValid: false };
  }

  const ownerInfo = parseOwner(owner);

  const entityParts = parts.slice(1);
  if (entityParts.length === 0) {
    return { owner, ownerInfo, segments: [], isValid: true };
  }

  if (entityParts.length % 2 !== 0) {
    return { owner, ownerInfo, segments: [], isValid: false };
  }

  const segments: EntityPathSegment[] = [];
  for (let i = 0; i < entityParts.length; i += 2) {
    const entityType = entityParts[i];
    const slug = entityParts[i + 1];
    if (!entityType || !slug) {
      return { owner, ownerInfo, segments: [], isValid: false };
    }
    segments.push({
      entity_type: entityType,
      slug,
    });
  }

  return { owner, ownerInfo, segments, isValid: true };
}

export function getOwnerFromPath(path: string): string | null {
  return parseEntityPath(path).owner;
}

/**
 * NOTE: duplicated in src/utils/entity-management.ts (separate package boundary).
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
