import type { SubagentStore } from "./store";
import type { SubagentBackend, SubagentDelivery, SubagentResult, SubagentTask } from "./types";

export type SubagentExecutor = (task: SubagentTask, signal: AbortSignal) => Promise<SubagentResult>;

export async function dispatchSubagent(
  store: SubagentStore,
  task: SubagentTask,
  executors: Partial<Record<SubagentBackend, SubagentExecutor>>,
  authorize: (task: SubagentTask) => Promise<boolean>,
): Promise<void> {
  const executor = executors[task.backend];
  if (!executor) {
    await store.fail(task, "executor_unavailable");
    return;
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.max(1, Date.parse(task.deadlineAt) - Date.now()));
  let heartbeatRunning = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      if (!(await authorize(task)) || !(await store.heartbeat(task))) controller.abort();
    } catch {
      controller.abort();
    } finally { heartbeatRunning = false; }
  }, 10_000);
  try {
    if (!(await authorize(task))) throw new Error("subagent_capability_inactive");
    const result = await executor(task, controller.signal);
    if (!(await authorize(task))) throw new Error("subagent_capability_inactive");
    if (controller.signal.aborted) await store.fail(task, "execution_aborted");
    else await store.complete(task, result);
  } catch (error) {
    // 不把外部程序 stderr（可能含憑證）寫入使用者可見欄位。
    const safeCode = error instanceof Error && ["codex_needs_connection", "subagent_capability_inactive", "codex_turn_failed", "subagent_artifact_limit"].includes(error.message) ? error.message : "executor_failed";
    await store.fail(task, controller.signal.aborted ? "execution_aborted" : safeCode);
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
  }
}

export async function deliverSubagentCompletion(
  store: SubagentStore,
  id: string,
  deliver: (task: SubagentDelivery) => Promise<void>,
): Promise<boolean> {
  const task = await store.claimDelivery(id);
  if (!task) return false;
  // deliver 必須以 deliveryId 作 durable 去重；ack 前 crash 可以安全重送。
  await deliver(task);
  return store.acknowledgeDelivery(task);
}
