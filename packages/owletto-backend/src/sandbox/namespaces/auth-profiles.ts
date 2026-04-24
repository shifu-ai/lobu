/**
 * ClientSDK `authProfiles` namespace. Thin wrapper over `manageAuthProfiles`.
 *
 * Field-name conventions mirror the handler schema exactly:
 *   - `create` takes an optional `slug` for the new profile (the handler
 *     auto-derives one from display_name if omitted).
 *   - `get`, `test`, `delete` look profiles up by `auth_profile_slug`.
 *   - `update` takes the existing `auth_profile_slug` plus an optional
 *     new `slug` if the caller wants to rename.
 *   - Credentials use `credentials` (key/value) or `auth_data` (OAuth/browser
 *     session state).
 */

import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";

export type AuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface AuthProfileCreateInput {
  profile_kind: AuthProfileKind;
  connector_key: string;
  display_name: string;
  /** Optional stable slug for the new profile. Auto-derived when omitted. */
  slug?: string;
  credentials?: Record<string, string>;
  auth_data?: Record<string, unknown>;
  requested_scopes?: string[];
}

export interface AuthProfileUpdateInput {
  /** Identifies the profile to mutate. */
  auth_profile_slug: string;
  display_name?: string;
  /** Rename the profile. */
  slug?: string;
  credentials?: Record<string, string>;
  auth_data?: Record<string, unknown>;
  requested_scopes?: string[];
  status?: string;
  reconnect?: boolean;
}

export interface AuthProfilesNamespace {
  list(input?: {
    connector_key?: string;
    provider?: string;
    profile_kind?: AuthProfileKind;
  }): Promise<unknown>;
  get(auth_profile_slug: string): Promise<unknown>;
  test(auth_profile_slug: string): Promise<unknown>;
  create(input: AuthProfileCreateInput): Promise<unknown>;
  update(input: AuthProfileUpdateInput): Promise<unknown>;
  delete(
    auth_profile_slug: string,
    options?: { force?: boolean },
  ): Promise<unknown>;
}

export function buildAuthProfilesNamespace(
  ctx: ToolContext,
  env: Env,
): AuthProfilesNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageAuthProfiles(payload as never, env, ctx) as Promise<T>;

  return {
    list: (input) => call({ action: "list_auth_profiles", ...input }),
    get: (auth_profile_slug) =>
      call({ action: "get_auth_profile", auth_profile_slug }),
    test: (auth_profile_slug) =>
      call({ action: "test_auth_profile", auth_profile_slug }),
    create: (input) => call({ action: "create_auth_profile", ...input }),
    update: (input) => call({ action: "update_auth_profile", ...input }),
    delete: (auth_profile_slug, options) =>
      call({
        action: "delete_auth_profile",
        auth_profile_slug,
        ...options,
      }),
  };
}
