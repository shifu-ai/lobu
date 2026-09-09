import type { TaskScheduler } from "../../scheduled/task-scheduler";
import type { IMessageQueue } from "../infrastructure/queue/types";
import { deliverSubagentCompletion, dispatchSubagent, type SubagentExecutor } from "./dispatcher";
import type { SubagentStore } from "./store";
import type { SubagentBackend, SubagentDelivery, SubagentTask } from "./types";

export const SUBAGENT_DISPATCH = "task:subagent-dispatch";
const SUBAGENT_DELIVER = "subagent-deliver";

export function enqueueSubagentDispatch(queue: IMessageQueue, id: string): Promise<string> {
  return queue.send(SUBAGENT_DISPATCH, { id }, {
    singletonKey: `${SUBAGENT_DISPATCH}:${id}`, actionKey: SUBAGENT_DISPATCH,
  });
}

export async function registerSubagentTasks(scheduler: TaskScheduler, deps: {
  queue: IMessageQueue;
  store: SubagentStore;
  executors: Partial<Record<SubagentBackend, SubagentExecutor>>;
  authorize: (task: SubagentTask) => Promise<boolean>;
  deliver: (task: SubagentDelivery) => Promise<void>;
}): Promise<void> {
  // A recovered job may complete as soon as work() starts polling.
  // Register its continuation before exposing the consumer.
  scheduler.register<{ id: string }>(SUBAGENT_DELIVER, async ({ payload }) => {
    await deliverSubagentCompletion(deps.store, payload.id, deps.deliver);
  });
  await deps.queue.work<{ id: string }>(SUBAGENT_DISPATCH, async ({ id: runId, data }) => {
    const task = await deps.store.claim(data.id);
    if (!task) return;
    await dispatchSubagent(deps.store, { ...task, executionRunId: Number(runId) }, deps.executors, deps.authorize);
    await scheduler.spawn(SUBAGENT_DELIVER, { id: task.id }, { idempotencyKey: `${SUBAGENT_DELIVER}:${task.id}` });
  }, { concurrency: 3 });
  // Both scans are recovery paths: API crash after INSERT, expired worker lease,
  // or crash between terminal persistence and parent enqueue. No pod-local state.
  scheduler.register("subagent-reconcile", async () => {
    for (const id of await deps.store.pendingIds()) {
      await enqueueSubagentDispatch(deps.queue, id);
    }
    for (const id of await deps.store.pendingDeliveryIds()) {
      await scheduler.spawn(SUBAGENT_DELIVER, { id }, { idempotencyKey: `${SUBAGENT_DELIVER}:${id}` });
    }
  }, { cron: "* * * * *" });
}
