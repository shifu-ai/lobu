import { describe, expect, test } from "bun:test";
import type { WorkerTransport } from "@lobu/core";
import { WorkerError, WorkspaceError } from "@lobu/core";
import { handleExecutionError } from "../core/error-handler";

interface SignalErrorCall {
  error: Error;
  errorCode?: string;
}

interface StreamDeltaCall {
  delta: string;
  isFullReplacement?: boolean;
  isFinal?: boolean;
}

interface RecordingTransport extends WorkerTransport {
  signalErrorCalls: SignalErrorCall[];
  streamDeltaCalls: StreamDeltaCall[];
  signalDoneCalls: Array<string | undefined>;
  signalCompletionCount: number;
  statusUpdateCalls: Array<{ elapsedSeconds: number; state: string }>;
  customEventCalls: Array<{ name: string; data: Record<string, unknown> }>;
}

function createTransport(
  overrides: Partial<{
    signalError: (error: Error, code?: string) => Promise<void>;
    sendStreamDelta: (
      delta: string,
      isFullReplacement?: boolean,
      isFinal?: boolean
    ) => Promise<void>;
  }> = {}
): RecordingTransport {
  const t: RecordingTransport = {
    signalErrorCalls: [],
    streamDeltaCalls: [],
    signalDoneCalls: [],
    signalCompletionCount: 0,
    statusUpdateCalls: [],
    customEventCalls: [],
    setJobId() {
      /* noop */
    },
    setModuleData() {
      /* noop */
    },
    async sendStreamDelta(delta, isFullReplacement, isFinal) {
      t.streamDeltaCalls.push({ delta, isFullReplacement, isFinal });
      if (overrides.sendStreamDelta) {
        await overrides.sendStreamDelta(delta, isFullReplacement, isFinal);
      }
    },
    async signalDone(finalDelta) {
      t.signalDoneCalls.push(finalDelta);
    },
    async signalCompletion() {
      t.signalCompletionCount += 1;
    },
    async signalError(error, errorCode) {
      t.signalErrorCalls.push({ error, errorCode });
      if (overrides.signalError) {
        await overrides.signalError(error, errorCode);
      }
    },
    async sendStatusUpdate(elapsedSeconds, state) {
      t.statusUpdateCalls.push({ elapsedSeconds, state });
    },
    async sendCustomEvent(name, data) {
      t.customEventCalls.push({ name, data });
    },
  };
  return t;
}

describe("handleExecutionError", () => {
  test("classifies 'No model configured' as NO_MODEL_CONFIGURED and skips stream", async () => {
    const transport = createTransport();
    const err = new Error("No model configured for agent");

    await handleExecutionError(err, transport);

    expect(transport.signalErrorCalls).toHaveLength(1);
    expect(transport.signalErrorCalls[0]?.errorCode).toBe(
      "NO_MODEL_CONFIGURED"
    );
    expect(transport.signalErrorCalls[0]?.error).toBe(err);
    // Known error path does not send a stream delta
    expect(transport.streamDeltaCalls).toHaveLength(0);
  });

  test("classifies 'No provider specified' as NO_MODEL_CONFIGURED", async () => {
    const transport = createTransport();
    const err = new Error("Oh no: No provider specified in options");

    await handleExecutionError(err, transport);

    expect(transport.signalErrorCalls[0]?.errorCode).toBe(
      "NO_MODEL_CONFIGURED"
    );
  });

  test("formats generic Error with 'Worker crashed:' prefix and no class name", async () => {
    const transport = createTransport();
    const err = new Error("Something blew up");

    await handleExecutionError(err, transport);

    expect(transport.streamDeltaCalls).toHaveLength(1);
    expect(transport.streamDeltaCalls[0]?.delta).toBe(
      "💥 Worker crashed: Something blew up"
    );
    expect(transport.streamDeltaCalls[0]?.isFullReplacement).toBe(true);
    expect(transport.streamDeltaCalls[0]?.isFinal).toBe(true);
    expect(transport.signalErrorCalls).toHaveLength(1);
    expect(transport.signalErrorCalls[0]?.errorCode).toBeUndefined();
    expect(transport.signalErrorCalls[0]?.error).toBe(err);
  });

  test("treats WorkspaceError as generic (no class name in message)", async () => {
    const transport = createTransport();
    const err = new WorkspaceError("setup", "could not create directory");

    await handleExecutionError(err, transport);

    expect(transport.streamDeltaCalls[0]?.delta).toBe(
      "💥 Worker crashed: could not create directory"
    );
  });

  test("includes class name for non-generic errors", async () => {
    const transport = createTransport();
    const err = new WorkerError("execute", "boom");

    await handleExecutionError(err, transport);

    expect(transport.streamDeltaCalls[0]?.delta).toBe(
      "💥 Worker crashed (WorkerError): boom"
    );
  });

  test("handles non-Error throwables with 'Unknown error' message", async () => {
    const transport = createTransport();

    await handleExecutionError("just a string", transport);

    expect(transport.streamDeltaCalls).toHaveLength(1);
    expect(transport.streamDeltaCalls[0]?.delta).toBe(
      "💥 Worker crashed: Unknown error"
    );
    expect(transport.signalErrorCalls).toHaveLength(1);
    // Non-Error inputs get wrapped in a new Error(String(value))
    expect(transport.signalErrorCalls[0]?.error).toBeInstanceOf(Error);
    expect(transport.signalErrorCalls[0]?.error.message).toBe("just a string");
  });

  test("wraps numeric throwable into Error with String(error)", async () => {
    const transport = createTransport();

    await handleExecutionError(42, transport);

    expect(transport.signalErrorCalls[0]?.error).toBeInstanceOf(Error);
    expect(transport.signalErrorCalls[0]?.error.message).toBe("42");
  });

  test("preserves cause chain on the original Error passed through", async () => {
    const transport = createTransport();
    const root = new Error("disk full");
    const wrapped = new WorkspaceError("write", "failed to persist", root);

    await handleExecutionError(wrapped, transport);

    const passed = transport.signalErrorCalls[0]?.error;
    expect(passed).toBe(wrapped);
    // BaseError exposes a cause and a getFullMessage walker
    expect((wrapped as WorkspaceError).cause).toBe(root);
    expect((wrapped as WorkspaceError).getFullMessage()).toContain(
      "Caused by: disk full"
    );
  });

  test("re-throws original error if signalError fails on the unknown-error path", async () => {
    const original = new Error("boom");
    const transport = createTransport({
      async signalError() {
        throw new Error("gateway down");
      },
    });

    let caught: unknown;
    try {
      await handleExecutionError(original, transport);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  test("re-throws original error if sendStreamDelta fails", async () => {
    const original = new Error("boom");
    const transport = createTransport({
      async sendStreamDelta() {
        throw new Error("stream broken");
      },
    });

    let caught: unknown;
    try {
      await handleExecutionError(original, transport);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });

  test("re-throws original error on known-error path if signalError fails", async () => {
    const original = new Error("No model configured");
    const transport = createTransport({
      async signalError() {
        throw new Error("gateway down");
      },
    });

    let caught: unknown;
    try {
      await handleExecutionError(original, transport);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
  });
});
