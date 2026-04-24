/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";

export interface OperationsNamespace {
  listAvailable(input?: { entity_id?: number }): Promise<unknown>;
  execute(input: {
    connection_id: number;
    operation_key: string;
    input?: Record<string, unknown>;
    watcher_source?: { watcher_id: number; window_id: string };
  }): Promise<unknown>;
  listRuns(input?: {
    connection_id?: number;
    operation_key?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown>;
  getRun(run_id: number): Promise<unknown>;
  approve(run_id: number): Promise<unknown>;
  reject(run_id: number, reason?: string): Promise<unknown>;
}

export function buildOperationsNamespace(
  ctx: ToolContext,
  env: Env
): OperationsNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageOperations(payload as never, env, ctx) as Promise<T>;

  return {
    listAvailable: (input) => call({ action: "list_available", ...input }),
    execute: (input) => call({ action: "execute", ...input }),
    listRuns: (input) => call({ action: "list_runs", ...input }),
    getRun: (run_id) => call({ action: "get_run", run_id }),
    approve: (run_id) => call({ action: "approve", run_id }),
    reject: (run_id, reason) => call({ action: "reject", run_id, reason }),
  };
}
