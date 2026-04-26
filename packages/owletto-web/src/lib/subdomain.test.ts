import { describe, expect, it } from 'vitest';
import { extractSubdomainOwner } from './subdomain';

describe('extractSubdomainOwner', () => {
  const zone = 'lobu.ai';

  it('returns the org slug for a per-org subdomain', () => {
    expect(extractSubdomainOwner('delivery.lobu.ai', zone)).toBe('delivery');
  });

  it('strips a port before checking', () => {
    expect(extractSubdomainOwner('delivery.lobu.ai:443', zone)).toBe('delivery');
  });

  it('returns null for the canonical app host', () => {
    expect(extractSubdomainOwner('app.lobu.ai', zone)).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    expect(extractSubdomainOwner('www.lobu.ai', zone)).toBeNull();
    expect(extractSubdomainOwner('api.lobu.ai', zone)).toBeNull();
    expect(extractSubdomainOwner('mcp.lobu.ai', zone)).toBeNull();
  });

  it('returns null for the bare zone', () => {
    expect(extractSubdomainOwner('lobu.ai', zone)).toBeNull();
  });

  it('returns null for multi-label subdomains', () => {
    expect(extractSubdomainOwner('foo.bar.lobu.ai', zone)).toBeNull();
  });

  it('returns null when the host does not belong to the zone', () => {
    expect(extractSubdomainOwner('delivery.example.com', zone)).toBeNull();
  });

  it('returns null when zone is null', () => {
    expect(extractSubdomainOwner('delivery.lobu.ai', null)).toBeNull();
  });
});
