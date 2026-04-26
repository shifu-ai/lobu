import { describe, expect, it } from 'vitest';
import { addOwnerPrefix, stripOwnerPrefix } from './subdomain-history';

describe('addOwnerPrefix', () => {
  const owner = 'delivery';

  it('returns the prefix for "/"', () => {
    expect(addOwnerPrefix('/', owner)).toBe('/delivery');
    expect(addOwnerPrefix('', owner)).toBe('/delivery');
  });

  it('prepends the prefix for workspace subpaths', () => {
    expect(addOwnerPrefix('/watchers', owner)).toBe('/delivery/watchers');
    expect(addOwnerPrefix('/watchers/abc', owner)).toBe('/delivery/watchers/abc');
  });

  it('does not double-prefix when path already carries the owner segment', () => {
    expect(addOwnerPrefix('/delivery', owner)).toBe('/delivery');
    expect(addOwnerPrefix('/delivery/watchers', owner)).toBe('/delivery/watchers');
  });

  it('passes auth/oauth/account paths through unchanged', () => {
    expect(addOwnerPrefix('/auth/login', owner)).toBe('/auth/login');
    expect(addOwnerPrefix('/oauth/consent', owner)).toBe('/oauth/consent');
    expect(addOwnerPrefix('/account/settings', owner)).toBe('/account/settings');
  });
});

describe('stripOwnerPrefix', () => {
  const owner = 'delivery';

  it('strips the owner segment from the prefix-only href', () => {
    expect(stripOwnerPrefix('/delivery', owner)).toBe('/');
  });

  it('strips the owner segment from a workspace subpath', () => {
    expect(stripOwnerPrefix('/delivery/watchers', owner)).toBe('/watchers');
  });

  it('preserves search and hash when stripping', () => {
    expect(stripOwnerPrefix('/delivery/watchers?foo=1#x', owner)).toBe('/watchers?foo=1#x');
    expect(stripOwnerPrefix('/delivery?q=1', owner)).toBe('/?q=1');
  });

  it('leaves non-owner hrefs untouched', () => {
    expect(stripOwnerPrefix('/auth/login', owner)).toBe('/auth/login');
    expect(stripOwnerPrefix('/somewhere?q=1', owner)).toBe('/somewhere?q=1');
  });

  it('does not strip when path merely starts with the slug as a prefix substring', () => {
    expect(stripOwnerPrefix('/delivery-dashboard', owner)).toBe('/delivery-dashboard');
  });
});
