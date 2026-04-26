import { describe, expect, it } from 'vitest';
import { parseRouterSearch, stringifyRouterSearch } from './router-search';

describe('router search serialization', () => {
  it('keeps numeric-looking strings unquoted', () => {
    expect(stringifyRouterSearch({ entityIds: '62' })).toBe('?entityIds=62');
    expect(parseRouterSearch('?entityIds=62')).toEqual({ entityIds: 62 });
  });

  it('keeps comma-separated ids as a plain search param value', () => {
    const search = stringifyRouterSearch({ entityIds: '62,147' });

    expect(decodeURIComponent(search)).toBe('?entityIds=62,147');
    expect(parseRouterSearch(search)).toEqual({ entityIds: '62,147' });
  });

  it('still round-trips structured values through JSON', () => {
    const search = stringifyRouterSearch({ filters: { status: 'active' } });

    expect(parseRouterSearch(search)).toEqual({ filters: { status: 'active' } });
  });
});
