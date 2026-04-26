/**
 * Custom TanStack Router history that transparently maps `/foo` ↔ `/${owner}/foo`
 * on per-org subdomains. The router always sees the prefixed path (so
 * `/$owner/...` routes match), while the URL bar never shows the redundant
 * owner segment.
 *
 * Top-level segments that are NOT under `$owner` (auth, oauth, account) are
 * passed through unchanged in both directions.
 */

import { createBrowserHistory, type RouterHistory } from '@tanstack/react-router';

const NON_OWNER_TOP_LEVELS = new Set(['auth', 'oauth', 'account']);

function isOwnerPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;
  const firstSeg = pathname.split('/')[1] ?? '';
  return !NON_OWNER_TOP_LEVELS.has(firstSeg);
}

function splitHref(href: string): { path: string; rest: string } {
  const match = href.match(/^([^?#]*)(.*)$/);
  return { path: match?.[1] ?? href, rest: match?.[2] ?? '' };
}

export function addOwnerPrefix(pathname: string, owner: string): string {
  const prefix = `/${owner}`;
  if (!isOwnerPath(pathname)) return pathname;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return pathname;
  if (pathname === '/' || pathname === '') return prefix;
  return `${prefix}${pathname}`;
}

export function stripOwnerPrefix(href: string, owner: string): string {
  const prefix = `/${owner}`;
  const { path, rest } = splitHref(href);
  if (path === prefix) return `/${rest}`;
  if (path.startsWith(`${prefix}/`)) return `${path.slice(prefix.length)}${rest}`;
  return href;
}

function buildLocation(href: string, state: unknown) {
  const hashIndex = href.indexOf('#');
  const searchIndex = href.indexOf('?');
  const pathnameEnd =
    hashIndex > 0
      ? searchIndex > 0
        ? Math.min(hashIndex, searchIndex)
        : hashIndex
      : searchIndex > 0
        ? searchIndex
        : href.length;
  const pathname = href.substring(0, pathnameEnd);
  const search = searchIndex > -1 ? href.slice(searchIndex, hashIndex === -1 ? undefined : hashIndex) : '';
  const hash = hashIndex > -1 ? href.substring(hashIndex) : '';
  return {
    href,
    pathname,
    search,
    hash,
    state: (state ?? {}) as Record<string, unknown> & { __TSR_index: number },
  };
}

export function createSubdomainHistory(owner: string): RouterHistory {
  return createBrowserHistory({
    parseLocation: () => {
      const pathname = addOwnerPrefix(window.location.pathname, owner);
      const href = `${pathname}${window.location.search}${window.location.hash}`;
      return buildLocation(href, window.history.state);
    },
    createHref: (path) => stripOwnerPrefix(path, owner),
  });
}
