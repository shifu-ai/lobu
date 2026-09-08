import type { IMessageQueue } from "../infrastructure/queue/types";
import type { TaskScheduler } from "../../scheduled/task-scheduler";
import { CodexAuthStore } from "./codex-auth-store";
import { runCodexLogin } from "./codex-auth-runner";
import type { CodexRuntimeOptions } from "./codex-executor";
import { cleanupCodexTemporaryHomes } from "./codex-cleanup";

const QUEUE = "task:subagent-codex-auth";
export function enqueueCodexLogin(queue: IMessageQueue, id: string): Promise<string> {
  return queue.send(QUEUE, { id }, { singletonKey: `codex-login:${id}` });
}
export async function registerCodexAuthTasks(scheduler: TaskScheduler, queue: IMessageQueue, store: CodexAuthStore, options: CodexRuntimeOptions | null): Promise<void> {
  await queue.work<{ id: string }>(QUEUE, async ({ data }) => {
    const flow = await store.claim(data.id);
    if (!flow) return;
    if (!options) { await store.fail(flow); return; }
    await runCodexLogin(store, flow, options);
  }, { concurrency: 3 });
  scheduler.register("subagent-codex-auth-reconcile", async () => {
    for (const id of await store.pendingIds()) await enqueueCodexLogin(queue, id);
  }, { cron: "* * * * *" });
  if (options) scheduler.register("subagent-codex-home-cleanup", async () => {
    await cleanupCodexTemporaryHomes(options.stateRoot);
  }, { cron: "17 * * * *" });
}
