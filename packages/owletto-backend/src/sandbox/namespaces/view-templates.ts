/**
 * ClientSDK `viewTemplates` namespace. Thin wrapper over `manageViewTemplates`.
 */

import type { Env } from "../../index";
import { manageViewTemplates } from "../../tools/admin/manage_view_templates";
import type { ToolContext } from "../../tools/registry";

type ResourceType = "entity_type" | "entity";

export interface ViewTemplatesNamespace {
  get(input: {
    resource_type: ResourceType;
    resource_id: string;
  }): Promise<unknown>;
  set(input: {
    resource_type: ResourceType;
    resource_id: string;
    template: Record<string, unknown>;
    data_sources?: Record<string, unknown>;
  }): Promise<unknown>;
  rollback(input: {
    resource_type: ResourceType;
    resource_id: string;
    version_id: number;
  }): Promise<unknown>;
  removeTab(input: {
    resource_type: ResourceType;
    resource_id: string;
    tab_name: string;
  }): Promise<unknown>;
}

export function buildViewTemplatesNamespace(
  ctx: ToolContext,
  env: Env
): ViewTemplatesNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageViewTemplates(payload as never, env, ctx) as Promise<T>;

  return {
    get: (input) => call({ action: "get", ...input }),
    set: (input) => call({ action: "set", ...input }),
    rollback: (input) => call({ action: "rollback", ...input }),
    removeTab: (input) => call({ action: "remove_tab", ...input }),
  };
}
