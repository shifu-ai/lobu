/**
 * ClientSDK `watchers` namespace.
 *
 * Thin wrapper over `manageWatchers`. Covers the hot-path operations
 * (list, get, create, update, delete, reaction management). Result shape
 * follows the existing handler return types — PR-2 tightens the typing.
 */

import type { Env } from "../../index";
import {
  listWatchers,
  manageWatchers,
} from "../../tools/admin/manage_watchers";
import type { ToolContext } from "../../tools/registry";

export interface WatcherListFilter {
  entity_id?: number;
  status?: "active" | "paused" | "draft";
  limit?: number;
  offset?: number;
}

export interface WatcherCreateInput {
  entity_id: number;
  prompt: string;
  extraction_schema: Record<string, unknown>;
  sources?: Array<{ name: string; query: string }>;
  status?: "active" | "paused" | "draft";
  granularity_seconds?: number;
  model?: string;
}

export interface WatchersNamespace {
  list(filter?: WatcherListFilter): Promise<unknown>;
  get(watcher_id: number): Promise<unknown>;
  create(input: WatcherCreateInput): Promise<unknown>;
  update(input: {
    watcher_id: number;
    [key: string]: unknown;
  }): Promise<unknown>;
  delete(watcher_id: number): Promise<unknown>;
  setReactionScript(input: {
    watcher_id: number;
    source: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
  completeWindow(input: {
    watcher_id: number;
    window_id: string;
    extracted_data: Record<string, unknown>;
    prompt_rendered?: string;
  }): Promise<unknown>;
}

export function buildWatchersNamespace(
  ctx: ToolContext,
  env: Env
): WatchersNamespace {
  return {
    list(filter) {
      return listWatchers(
        (filter ?? {}) as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    async get(watcher_id) {
      const { getWatcher } = await import("../../tools/get_watchers");
      return getWatcher({ watcher_id } as never, env, ctx) as Promise<unknown>;
    },
    create(input) {
      return manageWatchers(
        { action: "create", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    update(input) {
      return manageWatchers(
        { action: "update", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    delete(watcher_id) {
      return manageWatchers(
        { action: "delete", watcher_id } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    setReactionScript(input) {
      return manageWatchers(
        { action: "set_reaction_script", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
    completeWindow(input) {
      return manageWatchers(
        { action: "complete_window", ...input } as never,
        env,
        ctx
      ) as Promise<unknown>;
    },
  };
}
