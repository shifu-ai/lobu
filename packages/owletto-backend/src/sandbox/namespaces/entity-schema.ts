/**
 * ClientSDK `entitySchema` namespace. Thin wrapper over `manageEntitySchema`.
 *
 * The underlying handler is discriminated by `schema_type` *and* `action`; the
 * namespace splits those into method names so callers don't have to track both.
 */

import type { Env } from "../../index";
import { manageEntitySchema } from "../../tools/admin/manage_entity_schema";
import type { ToolContext } from "../../tools/registry";

export interface EntitySchemaNamespace {
  listTypes(): Promise<unknown>;
  getType(entity_type_slug: string): Promise<unknown>;
  createType(input: {
    slug: string;
    name: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  updateType(input: {
    entity_type_slug: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  deleteType(entity_type_slug: string): Promise<unknown>;
  auditType(entity_type_slug: string): Promise<unknown>;

  listRelTypes(): Promise<unknown>;
  getRelType(relationship_type_slug: string): Promise<unknown>;
  createRelType(input: {
    slug: string;
    name: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  updateRelType(input: {
    relationship_type_slug: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  deleteRelType(relationship_type_slug: string): Promise<unknown>;
  addRule(input: {
    relationship_type_slug: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  removeRule(input: {
    relationship_type_slug: string;
    rule_id: number;
  }): Promise<unknown>;
  listRules(relationship_type_slug: string): Promise<unknown>;
}

export function buildEntitySchemaNamespace(
  ctx: ToolContext,
  env: Env
): EntitySchemaNamespace {
  const callEntity = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageEntitySchema(
      { schema_type: "entity_type", ...payload } as never,
      env,
      ctx
    ) as Promise<T>;
  const callRel = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageEntitySchema(
      { schema_type: "relationship_type", ...payload } as never,
      env,
      ctx
    ) as Promise<T>;

  return {
    listTypes: () => callEntity({ action: "list" }),
    getType: (entity_type_slug) =>
      callEntity({ action: "get", entity_type_slug }),
    createType: (input) => callEntity({ action: "create", ...input }),
    updateType: (input) => callEntity({ action: "update", ...input }),
    deleteType: (entity_type_slug) =>
      callEntity({ action: "delete", entity_type_slug }),
    auditType: (entity_type_slug) =>
      callEntity({ action: "audit", entity_type_slug }),

    listRelTypes: () => callRel({ action: "list" }),
    getRelType: (relationship_type_slug) =>
      callRel({ action: "get", relationship_type_slug }),
    createRelType: (input) => callRel({ action: "create", ...input }),
    updateRelType: (input) => callRel({ action: "update", ...input }),
    deleteRelType: (relationship_type_slug) =>
      callRel({ action: "delete", relationship_type_slug }),
    addRule: (input) => callRel({ action: "add_rule", ...input }),
    removeRule: (input) => callRel({ action: "remove_rule", ...input }),
    listRules: (relationship_type_slug) =>
      callRel({ action: "list_rules", relationship_type_slug }),
  };
}
