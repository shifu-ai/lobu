/**
 * ClientSDK `operations` namespace. Thin wrapper over `manageOperations`.
 *
 * `execute` is the only method flagged `access: 'external'` — dry-run mode
 * (PR-2) intercepts these calls instead of sending them.
 */

import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";

export interface OperationsExecuteInput {
  connection_id: number;
  operation_key: string;
  input?: Record<string, unknown>;
  /**
   * Watcher provenance when this operation fires from a reaction. Both ids are
   * numeric.
   */
  watcher_source?: { watcher_id: number; window_id: number };
}

export interface OperationsNamespace {
  listAvailable(input?: { entity_id?: number }): Promise<unknown>;
  execute(input: OperationsExecuteInput): Promise<unknown>;
  listRuns(input?: {
    connection_id?: number;
    operation_key?: string;
    status?: string;
    approval_status?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown>;
  getRun(run_id: number): Promise<unknown>;
  approve(input: {
    run_id: number;
    input?: Record<string, unknown>;
  }): Promise<unknown>;
  reject(input: { run_id: number; reason?: string }): Promise<unknown>;
}

export function buildOperationsNamespace(
  ctx: ToolContext,
  env: Env,
): OperationsNamespace {
  const call = <T>(payload: Record<string, unknown>): Promise<T> =>
    manageOperations(payload as never, env, ctx) as Promise<T>;

  return {
    listAvailable: (input) => call({ action: "list_available", ...input }),
    execute: (input) => call({ action: "execute", ...input }),
    listRuns: (input) => call({ action: "list_runs", ...input }),
    getRun: (run_id) => call({ action: "get_run", run_id }),
    approve: (input) => call({ action: "approve", ...input }),
    reject: (input) => call({ action: "reject", ...input }),
  };
}
