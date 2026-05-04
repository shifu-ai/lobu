import { describe, expect, test } from "bun:test";
import { MessageBatcher } from "../gateway/message-batcher";
import type { MessagePayload, QueuedMessage } from "../gateway/types";

function makePayload(messageId: string, text: string = "hi"): MessagePayload {
  return {
    botId: "bot-1",
    userId: "user-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    platform: "test",
    channelId: "C1",
    messageId,
    messageText: text,
    platformMetadata: {},
    agentOptions: {},
  } as MessagePayload;
}

function makeQueuedMessage(
  messageId: string,
  timestamp: number,
  text?: string
): QueuedMessage {
  return {
    payload: makePayload(messageId, text),
    timestamp,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MessageBatcher", () => {
  test("getPendingCount returns 0 initially", () => {
    const batcher = new MessageBatcher({ batchWindowMs: 50 });
    expect(batcher.getPendingCount()).toBe(0);
    expect(batcher.isCurrentlyProcessing()).toBe(false);
    batcher.stop();
  });

  test("processes the very first message immediately (skipping batch window)", async () => {
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 200,
      onBatchReady: async (messages) => {
        calls.push(messages);
      },
    });

    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));

    expect(calls.length).toBe(1);
    expect(calls[0]?.length).toBe(1);
    expect(calls[0]?.[0]?.payload.messageId).toBe("m1");
    expect(batcher.getPendingCount()).toBe(0);
    batcher.stop();
  });

  test("subsequent messages are batched within the window", async () => {
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 80,
      onBatchReady: async (messages) => {
        calls.push(messages);
      },
    });

    // First message processes immediately.
    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));
    expect(calls.length).toBe(1);

    // Next two within the window go into the same batch.
    await batcher.addMessage(makeQueuedMessage("m2", Date.now()));
    await batcher.addMessage(makeQueuedMessage("m3", Date.now()));
    expect(batcher.getPendingCount()).toBe(2);

    // Wait for batch window to elapse + a buffer.
    await delay(150);

    expect(calls.length).toBe(2);
    const secondBatch = calls[1];
    expect(secondBatch?.length).toBe(2);
    const ids = secondBatch?.map((m) => m.payload.messageId);
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    batcher.stop();
  });

  test("batched messages are sorted by timestamp", async () => {
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 60,
      onBatchReady: async (messages) => {
        calls.push(messages);
      },
    });

    // Initial flush so the next adds open a batch window.
    await batcher.addMessage(makeQueuedMessage("init", 0));

    // Add out-of-order timestamps.
    await batcher.addMessage(makeQueuedMessage("late", 200));
    await batcher.addMessage(makeQueuedMessage("early", 100));

    await delay(120);

    const batch = calls[1];
    expect(batch).toBeTruthy();
    expect(batch?.[0]?.payload.messageId).toBe("early");
    expect(batch?.[1]?.payload.messageId).toBe("late");
    batcher.stop();
  });

  test("messages added during onBatchReady are processed in a follow-up batch", async () => {
    let invocations = 0;
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 30,
      onBatchReady: async (messages) => {
        invocations++;
        calls.push(messages);
        // While the first batch is "processing", enqueue another message.
        if (invocations === 1) {
          await batcher.addMessage(
            makeQueuedMessage("during-processing", Date.now())
          );
        }
      },
    });

    await batcher.addMessage(makeQueuedMessage("first", Date.now()));

    // Wait long enough for the follow-up batch window.
    await delay(120);

    expect(invocations).toBeGreaterThanOrEqual(2);
    // The follow-up batch must contain the message added during processing.
    const flat = calls.flat().map((m) => m.payload.messageId);
    expect(flat).toContain("during-processing");
    batcher.stop();
  });

  test("stop() cancels a pending batch timer and prevents flush", async () => {
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      batchWindowMs: 60,
      onBatchReady: async (messages) => {
        calls.push(messages);
      },
    });

    // First message flushes immediately.
    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));
    // Next message starts the batch timer.
    await batcher.addMessage(makeQueuedMessage("m2", Date.now()));
    expect(batcher.getPendingCount()).toBe(1);

    // Stop before the timer fires.
    batcher.stop();

    await delay(120);
    // Only the first immediate flush should have happened.
    expect(calls.length).toBe(1);
    // Pending message stays queued because we never flushed.
    expect(batcher.getPendingCount()).toBe(1);
  });

  test("works without an onBatchReady callback (no throw)", async () => {
    const batcher = new MessageBatcher({ batchWindowMs: 30 });
    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));
    await batcher.addMessage(makeQueuedMessage("m2", Date.now()));
    await delay(80);
    // Queue should be drained (m1 immediately, m2 after window).
    expect(batcher.getPendingCount()).toBe(0);
    batcher.stop();
  });

  test("default batchWindowMs is 2000ms when unspecified", async () => {
    const calls: QueuedMessage[][] = [];
    const batcher = new MessageBatcher({
      onBatchReady: async (messages) => {
        calls.push(messages);
      },
    });

    // First flush is immediate.
    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));
    // Queue a second; it should NOT flush within 100ms with the default 2s window.
    await batcher.addMessage(makeQueuedMessage("m2", Date.now()));
    await delay(100);
    expect(calls.length).toBe(1);
    expect(batcher.getPendingCount()).toBe(1);
    batcher.stop();
  });

  test("isCurrentlyProcessing reflects state during onBatchReady", async () => {
    let observedDuring = false;
    const batcher = new MessageBatcher({
      batchWindowMs: 20,
      onBatchReady: async () => {
        observedDuring = batcher.isCurrentlyProcessing();
      },
    });

    await batcher.addMessage(makeQueuedMessage("m1", Date.now()));
    expect(observedDuring).toBe(true);
    expect(batcher.isCurrentlyProcessing()).toBe(false);
    batcher.stop();
  });

  test("errors thrown from onBatchReady are swallowed by the batch timer", async () => {
    let invocations = 0;
    const batcher = new MessageBatcher({
      batchWindowMs: 30,
      onBatchReady: async () => {
        invocations++;
        throw new Error("boom");
      },
    });

    // First flush is immediate and will throw — addMessage awaits processBatch.
    await expect(
      batcher.addMessage(makeQueuedMessage("m1", Date.now()))
    ).rejects.toThrow("boom");
    expect(invocations).toBe(1);

    // After the rejected immediate flush, the next message enters the batch timer
    // path. The timer-driven processBatch swallows errors via .catch(() => {}).
    await batcher.addMessage(makeQueuedMessage("m2", Date.now()));
    await delay(80);
    expect(invocations).toBe(2);
    batcher.stop();
  });
});
