import { defaultParseSearch, stringifySearchWith } from '@tanstack/react-router';

/**
 * Keep primitive search params human-readable (`entityIds=62,147`) while still
 * JSON-serializing structured values like arrays and objects.
 */
export const parseRouterSearch = defaultParseSearch;
export const stringifyRouterSearch = stringifySearchWith(JSON.stringify);

/**
 * TSR treats `{key: undefined}` as different from `{}` when diffing search state,
 * because the URL stringifier drops undefined keys but `validateSearch` keeps
 * returning them. That mismatch causes an infinite commit loop inside
 * `Transitioner` on initial mount (React bails after ~150 setStates with
 * "Maximum update depth exceeded"). Always strip undefined values from the
 * object returned by `validateSearch`.
 */
export function pruneSearch<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
