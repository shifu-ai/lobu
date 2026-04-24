/**
 * ClientSDK `feeds` namespace. Thin wrapper over `manageFeeds`.
 */

import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";

export interface FeedsNamespace {
  list(input?: { connection_id?: number }): Promise<unknown>;
  get(feed_id: number): Promise<unknown>;
  create(input: {
    connection_id: number;
    name: string;
    schedule?: string;
    config?: Record<string, unknown>;
  }): Promise<unknown>;
  update(input: { feed_id: number; [key: string]: unknown }): Promise<unknown>;
  delete(feed_id: number): Promise<unknown>;
  trigger(feed_id: number): Promise<unknown>;
}

export function buildFeedsNamespace(
  ctx: ToolContext,
  env: Env
): FeedsNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageFeeds(payload as never, env, ctx) as Promise<T>;

  return {
    list: (input) => call({ action: "list_feeds", ...input }),
    get: (feed_id) => call({ action: "get_feed", feed_id }),
    create: (input) => call({ action: "create_feed", ...input }),
    update: (input) => call({ action: "update_feed", ...input }),
    delete: (feed_id) => call({ action: "delete_feed", feed_id }),
    trigger: (feed_id) => call({ action: "trigger_feed", feed_id }),
  };
}
