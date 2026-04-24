/**
 * ClientSDK `authProfiles` namespace. Thin wrapper over `manageAuthProfiles`.
 */

import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";

export interface AuthProfilesNamespace {
  list(): Promise<unknown>;
  get(auth_profile_id: number): Promise<unknown>;
  test(auth_profile_id: number): Promise<unknown>;
  create(input: {
    name: string;
    connector_key: string;
    credentials: Record<string, unknown>;
  }): Promise<unknown>;
  update(input: {
    auth_profile_id: number;
    [key: string]: unknown;
  }): Promise<unknown>;
  delete(auth_profile_id: number): Promise<unknown>;
}

export function buildAuthProfilesNamespace(
  ctx: ToolContext,
  env: Env
): AuthProfilesNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageAuthProfiles(payload as never, env, ctx) as Promise<T>;

  return {
    list: () => call({ action: "list_auth_profiles" }),
    get: (auth_profile_id) =>
      call({ action: "get_auth_profile", auth_profile_id }),
    test: (auth_profile_id) =>
      call({ action: "test_auth_profile", auth_profile_id }),
    create: (input) => call({ action: "create_auth_profile", ...input }),
    update: (input) => call({ action: "update_auth_profile", ...input }),
    delete: (auth_profile_id) =>
      call({ action: "delete_auth_profile", auth_profile_id }),
  };
}
