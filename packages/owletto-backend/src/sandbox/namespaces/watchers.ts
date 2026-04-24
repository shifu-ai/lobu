/**
 * ClientSDK `watchers` namespace. Thin wrapper over `manageWatchers` +
 * `listWatchers` + `getWatcher`.
 *
 * Field names mirror the underlying handlers (see
 * `packages/owletto-backend/src/tools/admin/manage_watchers.ts`):
 * - `watcher_id` is a numeric string
 * - `delete` takes `watcher_ids: string[]`
 * - `complete_window` requires `window_token` (JWT) not a raw window id
 * - `set_reaction_script` uses `reaction_script` as the source field
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
  schedule?: string;
  slug?: string;
  name?: string;
  description?: string;
  json_template?: Record<string, unknown>;
  keying_config?: Record<string, unknown>;
  classifiers?: Record<string, unknown>;
  condensation_prompt?: string;
  reactions_guidance?: string;
  agent_id?: string;
  tags?: string[];
}

export interface WatcherUpdateInput {
  watcher_id: string;
  schedule?: string;
  agent_id?: string;
  model_config?: Record<string, unknown>;
  sources?: Array<{ name: string; query: string }>;
}

export interface WatcherCompleteWindowInput {
  watcher_id: string;
  /** JWT obtained from read_knowledge(watcher_id, since, until). */
  window_token: string;
  extracted_data: Record<string, unknown>;
  replace_existing?: boolean;
  model?: string;
  run_metadata?: Record<string, unknown>;
}

export interface WatchersNamespace {
  list(filter?: WatcherListFilter): Promise<unknown>;
  get(watcher_id: string | number): Promise<unknown>;
  create(input: WatcherCreateInput): Promise<unknown>;
  update(input: WatcherUpdateInput): Promise<unknown>;
  /**
   * Delete one or more watchers. Accepts a single id or an array; internally
   * dispatched as `watcher_ids`.
   */
  delete(watcher_id: string | string[]): Promise<unknown>;
  setReactionScript(input: {
    watcher_id: string;
    /** TypeScript source. Empty string removes the script. */
    reaction_script: string;
  }): Promise<unknown>;
  completeWindow(input: WatcherCompleteWindowInput): Promise<unknown>;
}

function asWatcherIdString(v: string | number): string {
  return typeof v === "number" ? String(v) : v;
}

export function buildWatchersNamespace(
  ctx: ToolContext,
  env: Env,
): WatchersNamespace {
  return {
    list(filter) {
      return listWatchers(
        (filter ?? {}) as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    async get(watcher_id) {
      const { getWatcher } = await import("../../tools/get_watchers");
      return getWatcher(
        { watcher_id: asWatcherIdString(watcher_id) } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    create(input) {
      return manageWatchers(
        { action: "create", ...input } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    update(input) {
      return manageWatchers(
        {
          action: "update",
          ...input,
          watcher_id: asWatcherIdString(input.watcher_id),
        } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    delete(watcher_id) {
      const watcher_ids = Array.isArray(watcher_id)
        ? watcher_id.map(asWatcherIdString)
        : [asWatcherIdString(watcher_id)];
      return manageWatchers(
        { action: "delete", watcher_ids } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    setReactionScript(input) {
      return manageWatchers(
        {
          action: "set_reaction_script",
          watcher_id: asWatcherIdString(input.watcher_id),
          reaction_script: input.reaction_script,
        } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
    completeWindow(input) {
      return manageWatchers(
        {
          action: "complete_window",
          ...input,
          watcher_id: asWatcherIdString(input.watcher_id),
        } as never,
        env,
        ctx,
      ) as Promise<unknown>;
    },
  };
}
