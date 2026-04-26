import type { EntityListResult, EntityType, ResolvePathResult } from './api/entities';

export interface PublicPageBootstrap {
  path: string;
  ownerSlug: string;
  kind: 'workspace' | 'entity' | 'entity-type';
  resolvedPath?: ResolvePathResult;
  ownerResolvedPath?: ResolvePathResult;
  entityTypeSlug?: string;
  entityType?: EntityType | null;
  entityList?: EntityListResult;
}

function normalizePath(path: string): string {
  const [pathname = ''] = path.split('?', 2);
  return `/${pathname.replace(/^\/+|\/+$/g, '')}`;
}

export function getPublicBootstrap(): PublicPageBootstrap | null {
  if (typeof window === 'undefined') return null;
  return window.__OWLETTO_PUBLIC_BOOTSTRAP__ ?? null;
}

export function hasPublicBootstrapForPath(path: string): boolean {
  const bootstrap = getPublicBootstrap();
  if (!bootstrap) return false;
  return normalizePath(bootstrap.path) === normalizePath(path);
}

export function getResolvedPathInitialData(path: string): ResolvePathResult | undefined {
  const bootstrap = getPublicBootstrap();
  if (!bootstrap) return undefined;

  const normalizedPath = normalizePath(path);
  if (bootstrap.resolvedPath && normalizePath(bootstrap.path) === normalizedPath) {
    return bootstrap.resolvedPath;
  }

  const ownerPath = `/${bootstrap.ownerSlug}`;
  if (normalizePath(ownerPath) === normalizedPath) {
    return bootstrap.ownerResolvedPath ?? bootstrap.resolvedPath;
  }

  return undefined;
}

export function getEntityTypeInitialData(
  ownerSlug: string,
  entityTypeSlug: string
): EntityType | null | undefined {
  const bootstrap = getPublicBootstrap();
  if (!bootstrap) return undefined;
  if (bootstrap.kind !== 'entity-type') return undefined;
  if (bootstrap.ownerSlug !== ownerSlug || bootstrap.entityTypeSlug !== entityTypeSlug)
    return undefined;
  return bootstrap.entityType;
}

export function getEntityListInitialData(params: {
  ownerSlug: string;
  entityTypeSlug: string;
  limit?: number;
  offset?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}): EntityListResult | undefined {
  const bootstrap = getPublicBootstrap();
  if (!bootstrap?.entityList) return undefined;
  if (bootstrap.kind !== 'entity-type') return undefined;
  if (
    bootstrap.ownerSlug !== params.ownerSlug ||
    bootstrap.entityTypeSlug !== params.entityTypeSlug
  ) {
    return undefined;
  }

  const matchesInitialView =
    (params.limit ?? 50) === 50 &&
    (params.offset ?? 0) === 0 &&
    !params.search?.trim() &&
    (params.sortBy ?? 'created_at') === 'created_at' &&
    (params.sortOrder ?? 'desc') === 'desc';

  return matchesInitialView ? bootstrap.entityList : undefined;
}
