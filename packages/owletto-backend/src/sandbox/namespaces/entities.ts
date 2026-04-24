/**
 * ClientSDK `entities` namespace.
 *
 * Delegates to `manageEntity` with action-discriminated payloads. Per-call auth
 * checks fire inside the handler; this wrapper does not duplicate them.
 */

import type { Env } from "../../index";
import { manageEntity } from "../../tools/admin/manage_entity";
import type { ToolContext } from "../../tools/registry";

export interface EntityListFilter {
  entity_type?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  category?: string;
  main_market?: string;
  market?: string;
}

export interface EntityCreateInput {
  type: string;
  name: string;
  slug?: string;
  content?: string;
  parent_id?: number;
  metadata?: Record<string, unknown>;
  enabled_classifiers?: string[];
}

export interface EntityUpdateInput {
  entity_id: number;
  name?: string;
  slug?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  enabled_classifiers?: string[];
}

export interface EntityLinkInput {
  from_entity_id: number;
  to_entity_id: number;
  relationship_type_slug: string;
  metadata?: Record<string, unknown>;
}

export interface EntitiesNamespace {
  list(filter?: EntityListFilter): Promise<unknown>;
  get(entity_id: number): Promise<unknown>;
  create(input: EntityCreateInput): Promise<unknown>;
  update(input: EntityUpdateInput): Promise<unknown>;
  delete(
    entity_id: number,
    options?: { force_delete_tree?: boolean }
  ): Promise<unknown>;
  link(input: EntityLinkInput): Promise<unknown>;
  unlink(input: {
    from_entity_id: number;
    to_entity_id: number;
    relationship_type_slug: string;
  }): Promise<unknown>;
  updateLink(input: {
    from_entity_id: number;
    to_entity_id: number;
    relationship_type_slug: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  listLinks(input: {
    entity_id: number;
    relationship_type_slug?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown>;
  search(query: string, options?: { limit?: number }): Promise<unknown>;
}

export function buildEntitiesNamespace(
  ctx: ToolContext,
  env: Env
): EntitiesNamespace {
  return {
    list(filter) {
      return manageEntity(
        { action: "list", ...filter } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    get(entity_id) {
      return manageEntity(
        { action: "get", entity_id } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    create(input) {
      return manageEntity(
        {
          action: "create",
          entity_type: input.type,
          name: input.name,
          slug: input.slug,
          content: input.content,
          parent_id: input.parent_id,
          metadata: input.metadata,
          enabled_classifiers: input.enabled_classifiers,
        } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    update(input) {
      return manageEntity(
        { action: "update", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    delete(entity_id, options) {
      return manageEntity(
        {
          action: "delete",
          entity_id,
          force_delete_tree: options?.force_delete_tree,
        } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    link(input) {
      return manageEntity(
        { action: "link", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    unlink(input) {
      return manageEntity(
        { action: "unlink", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    updateLink(input) {
      return manageEntity(
        { action: "update_link", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    listLinks(input) {
      return manageEntity(
        { action: "list_links", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    async search(query, options) {
      const { search } = await import("../../tools/search");
      return search(
        { query, limit: options?.limit } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
  };
}
