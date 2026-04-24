/**
 * ClientSDK `authProfiles` namespace. Thin wrapper over `manageAuthProfiles`.
 *
 * All identifiers are `auth_profile_slug: string` — the handler does not use
 * numeric ids.
 */

import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";

export type AuthProfileType =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface AuthProfilesNamespace {
  list(): Promise<unknown>;
  get(auth_profile_slug: string): Promise<unknown>;
  test(auth_profile_slug: string): Promise<unknown>;
  create(input: {
    auth_profile_slug: string;
    auth_type: AuthProfileType;
    connector_key: string;
    display_name?: string;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  update(input: {
    auth_profile_slug: string;
    display_name?: string;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  delete(auth_profile_slug: string): Promise<unknown>;
}

export function buildAuthProfilesNamespace(
  ctx: ToolContext,
  env: Env,
): AuthProfilesNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageAuthProfiles(payload as never, env, ctx) as Promise<T>;

  return {
    list: () => call({ action: "list_auth_profiles" }),
    get: (auth_profile_slug) =>
      call({ action: "get_auth_profile", auth_profile_slug }),
    test: (auth_profile_slug) =>
      call({ action: "test_auth_profile", auth_profile_slug }),
    create: (input) => call({ action: "create_auth_profile", ...input }),
    update: (input) => call({ action: "update_auth_profile", ...input }),
    delete: (auth_profile_slug) =>
      call({ action: "delete_auth_profile", auth_profile_slug }),
  };
}
