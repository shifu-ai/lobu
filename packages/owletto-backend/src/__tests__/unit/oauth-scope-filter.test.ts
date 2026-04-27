import { describe, expect, it } from 'bun:test';
import { filterScopeByRole } from '../../auth/oauth/scopes';

describe('filterScopeByRole', () => {
  it('keeps mcp:admin when the user is an owner', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'owner');
    expect(result.split(' ')).toContain('mcp:admin');
    expect(result.split(' ')).toContain('mcp:write');
    expect(result.split(' ')).toContain('mcp:read');
    expect(result.split(' ')).toContain('profile:read');
  });

  it('keeps mcp:admin when the user is an admin', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'admin');
    expect(result.split(' ')).toContain('mcp:admin');
  });

  it('strips mcp:admin when the user is a regular member', () => {
    const result = filterScopeByRole('mcp:read mcp:write mcp:admin profile:read', 'member');
    expect(result.split(' ')).not.toContain('mcp:admin');
    expect(result.split(' ')).toContain('mcp:write');
    expect(result.split(' ')).toContain('mcp:read');
    expect(result.split(' ')).toContain('profile:read');
  });

  it('strips mcp:admin when the user has no membership', () => {
    const result = filterScopeByRole('mcp:read mcp:admin', null);
    expect(result.split(' ')).not.toContain('mcp:admin');
    expect(result.split(' ')).toContain('mcp:read');
  });

  it('passes through non-admin scopes unchanged for any role', () => {
    const result = filterScopeByRole('mcp:read mcp:write profile:read', 'member');
    expect(result).toBe('mcp:read mcp:write profile:read');
  });

  it('handles empty scope strings', () => {
    expect(filterScopeByRole('', 'member')).toBe('');
    expect(filterScopeByRole(null, 'member')).toBe('');
    expect(filterScopeByRole(undefined, 'owner')).toBe('');
  });

  it('collapses extra whitespace', () => {
    const result = filterScopeByRole('  mcp:read   mcp:admin   ', 'owner');
    expect(result).toBe('mcp:read mcp:admin');
  });
});
