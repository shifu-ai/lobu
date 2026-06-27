import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OpenClawProgressProcessor } from "../openclaw/processor";
import { OpenClawWorker } from "../openclaw/worker";
import { mockWorkerConfig } from "./setup";

let originalDispatcherUrl: string | undefined;
let originalWorkerToken: string | undefined;

beforeEach(() => {
  originalDispatcherUrl = process.env.DISPATCHER_URL;
  originalWorkerToken = process.env.WORKER_TOKEN;
  process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
  process.env.WORKER_TOKEN = "test-worker-token";
});

afterEach(() => {
  if (originalDispatcherUrl === undefined) {
    delete process.env.DISPATCHER_URL;
  } else {
    process.env.DISPATCHER_URL = originalDispatcherUrl;
  }
  if (originalWorkerToken === undefined) {
    delete process.env.WORKER_TOKEN;
  } else {
    process.env.WORKER_TOKEN = originalWorkerToken;
  }
});

type SentDelta = {
  delta: string;
  isFullReplacement?: boolean;
  isFinal?: boolean;
};

function buildWorkerWithRecorder() {
  const worker = new OpenClawWorker(mockWorkerConfig);
  const sent: SentDelta[] = [];
  const errors: Error[] = [];
  let doneCount = 0;
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  worker.workerTransport = {
    setJobId: noop,
    async sendStreamDelta(delta, isFullReplacement, isFinal) {
      sent.push({ delta, isFullReplacement, isFinal });
    },
    async signalDone() {
      doneCount += 1;
    },
    signalCompletion: asyncNoop,
    async signalError(error) {
      errors.push(error);
    },
    sendStatusUpdate: asyncNoop,
    sendCustomEvent: asyncNoop,
  };
  const processor = (worker as any)
    .progressProcessor as OpenClawProgressProcessor;
  const applyTaskCompletionGuard = (
    worker as any
  ).applyTaskCompletionGuard.bind(worker) as (
    latestUserText: string
  ) => Promise<boolean>;
  return {
    worker,
    sent,
    errors,
    getDoneCount: () => doneCount,
    processor,
    applyTaskCompletionGuard,
  };
}

describe("OpenClawWorker task completion guard", () => {
  test("fails loud when final visible text is empty", async () => {
    const { sent, errors, getDoneCount, applyTaskCompletionGuard } =
      buildWorkerWithRecorder();

    const result = await applyTaskCompletionGuard("請幫我整理這份文件");

    expect(result).toBe(false);
    expect(sent).toEqual([
      {
        delta:
          "我這輪沒有產生可交付的回覆，因此沒有把任務標成完成。請重新指示或稍後再試。",
        isFullReplacement: true,
        isFinal: true,
      },
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "task_completion_empty_final",
    ]);
    expect(getDoneCount()).toBe(0);
  });

  test("allows non-empty final text and restores final result for final delivery", async () => {
    const { sent, errors, processor, applyTaskCompletionGuard } =
      buildWorkerWithRecorder();
    processor.setFinalResult({ text: "我已經完成摘要。", isFinal: true });

    const result = await applyTaskCompletionGuard("請幫我整理這份文件");

    expect(result).toBe(true);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
    expect(processor.getFinalResult()).toEqual({
      text: "我已經完成摘要。",
      isFinal: true,
    });
  });

  test("fails loud when write intent has no successful write evidence", async () => {
    const { worker, sent, errors, applyTaskCompletionGuard, processor } =
      buildWorkerWithRecorder();
    processor.setFinalResult({ text: "我已經讀完文件。", isFinal: true });

    const result = await applyTaskCompletionGuard("請直接幫我修改 Google Doc");

    expect(result).toBe(false);
    expect((worker as any).terminalStatus).toBe("failed");
    expect(sent).toEqual([
      {
        delta:
          "我讀到了任務需要的資料，但這輪沒有成功執行寫入工具，因此沒有把任務標成完成。我沒有把任何變更寫入外部文件。",
        isFullReplacement: true,
        isFinal: true,
      },
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "task_completion_write_intent_without_write",
    ]);
  });

  test("fails loud when Google Docs writeback is not verified", async () => {
    const { worker, sent, errors, applyTaskCompletionGuard, processor } =
      buildWorkerWithRecorder();
    processor.setFinalResult({ text: "我已經完成 Google Doc 修改。", isFinal: true });
    processor.processEvent({
      type: "tool_execution_end",
      toolName: "gws_docs_batch_update",
      toolCallId: "call_1",
      isError: false,
      result: { replies: [{}] },
    } as any);

    const result = await applyTaskCompletionGuard("請直接幫我修改 Google Doc");

    expect(result).toBe(false);
    expect((worker as any).terminalStatus).toBe("failed");
    expect(sent).toEqual([
      {
        delta:
          "我有呼叫寫入工具，但這輪沒有取得外部文件確實被修改的證據，因此沒有把任務標成完成。請確認文件內容或重新指示我用可驗證的方式修改。",
        isFullReplacement: true,
        isFinal: true,
      },
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "task_completion_unverified_writeback",
    ]);
  });
});
