import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HttpWorkerTransport } from "../gateway/gateway-integration";

const baseConfig = {
  gatewayUrl: "https://gw.example.com",
  workerToken: "tok-123",
  userId: "user-1",
  channelId: "C1",
  conversationId: "conv-1",
  originalMessageTs: "msg-orig",
  botResponseTs: "msg-bot",
  teamId: "team-1",
  platform: "slack",
  platformMetadata: { team_id: "team-1" },
  processedMessageIds: ["m-prev"],
};

function jsonResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HttpWorkerTransport", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createTransport(overrides: Partial<typeof baseConfig> = {}) {
    return new HttpWorkerTransport({ ...baseConfig, ...overrides });
  }

  function lastRequestBody(): Record<string, unknown> {
    const lastCall = fetchMock.mock.calls.at(-1);
    const init = lastCall?.[1] as RequestInit | undefined;
    return JSON.parse(init?.body as string);
  }

  test("constructor seeds processedMessageIds from config", () => {
    const transport = createTransport();
    expect(transport.processedMessageIds).toEqual(["m-prev"]);
  });

  test("constructor defaults processedMessageIds to [] when omitted", () => {
    const transport = new HttpWorkerTransport({
      ...baseConfig,
      processedMessageIds: undefined,
    });
    expect(transport.processedMessageIds).toEqual([]);
  });

  test("sendStreamDelta posts to /worker/response with auth + delta payload", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("hello", false, false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("https://gw.example.com/worker/response");
    const init = call?.[1] as RequestInit;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(body.delta).toBe("hello");
    expect(body.userId).toBe("user-1");
    expect(body.channelId).toBe("C1");
    expect(body.conversationId).toBe("conv-1");
    expect(body.messageId).toBe("msg-orig");
    expect(body.originalMessageId).toBe("msg-orig");
    expect(body.botResponseId).toBe("msg-bot");
    expect(body.teamId).toBe("team-1");
    expect(body.platform).toBe("slack");
    expect(body.platformMetadata).toEqual({ team_id: "team-1" });
    expect(typeof body.timestamp).toBe("number");
    expect(body.isFullReplacement).toBe(false);
  });

  test("setJobId causes jobId to appear at the front of the payload", async () => {
    const transport = createTransport();
    transport.setJobId("job-xyz");
    await transport.sendStreamDelta("a", false, false);
    const body = lastRequestBody();
    expect(body.jobId).toBe("job-xyz");
  });

  test("setModuleData attaches moduleData to stream deltas", async () => {
    const transport = createTransport();
    transport.setModuleData({ foo: "bar" });
    await transport.sendStreamDelta("delta", false, false);
    const body = lastRequestBody();
    expect(body.moduleData).toEqual({ foo: "bar" });
  });

  test("isFinal: identical-to-accumulated final delta is suppressed", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("hello world", false, false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await transport.sendStreamDelta("hello world", false, true);
    // No additional fetch — duplicate suppressed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("isFinal: when final has accumulated as a prefix, only the suffix is sent", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("hello", false, false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await transport.sendStreamDelta("hello world", false, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = lastRequestBody();
    expect(body.delta).toBe(" world");
  });

  test("isFinal: when final differs from accumulated, full final is sent", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("foo", false, false);
    await transport.sendStreamDelta("totally different", false, true);
    const body = lastRequestBody();
    expect(body.delta).toBe("totally different");
  });

  test("isFinal: matches last delta after CRLF normalization → suppressed", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("first chunk", false, false);
    await transport.sendStreamDelta("line1\r\nline2  ", false, false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Final does not start with accumulated, but matches last delta when normalized.
    await transport.sendStreamDelta("line1\nline2", false, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("isFullReplacement resets accumulated content tracking", async () => {
    const transport = createTransport();
    await transport.sendStreamDelta("aaa", false, false);
    await transport.sendStreamDelta("BBB", true, false);
    // After replacement, "BBB" is the only accumulated content.
    await transport.sendStreamDelta("BBB", false, true);
    // Identical → suppressed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("signalDone with no delta sends a single completion response", async () => {
    const transport = createTransport();
    await transport.signalDone();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastRequestBody();
    expect(body.processedMessageIds).toEqual(["m-prev"]);
  });

  test("signalDone with a finalDelta sends the delta then the completion", async () => {
    const transport = createTransport();
    await transport.signalDone("the end");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const deltaCall = fetchMock.mock.calls[0];
    const completionCall = fetchMock.mock.calls[1];

    const deltaBody = JSON.parse(
      (deltaCall?.[1] as RequestInit).body as string
    );
    expect(deltaBody.delta).toBe("the end");

    const completionBody = JSON.parse(
      (completionCall?.[1] as RequestInit).body as string
    );
    expect(completionBody.processedMessageIds).toEqual(["m-prev"]);
    expect(completionBody.delta).toBeUndefined();
  });

  test("signalError serializes the error message and optional code", async () => {
    const transport = createTransport();
    await transport.signalError(new Error("nope"), "ERR_X");
    const body = lastRequestBody();
    expect(body.error).toBe("nope");
    expect(body.errorCode).toBe("ERR_X");
  });

  test("signalError without errorCode omits the field", async () => {
    const transport = createTransport();
    await transport.signalError(new Error("plain"));
    const body = lastRequestBody();
    expect(body.error).toBe("plain");
    expect(body.errorCode).toBeUndefined();
  });

  test("sendStatusUpdate emits structured status payload", async () => {
    const transport = createTransport();
    await transport.sendStatusUpdate(12, "thinking");
    const body = lastRequestBody();
    expect(body.statusUpdate).toEqual({
      elapsedSeconds: 12,
      state: "thinking",
    });
  });

  test("sendCustomEvent emits name + data envelope", async () => {
    const transport = createTransport();
    await transport.sendCustomEvent("file_uploaded", { id: "f1" });
    const body = lastRequestBody();
    expect(body.customEvent).toEqual({
      name: "file_uploaded",
      data: { id: "f1" },
    });
  });

  test("sendExecOutput tags execId and execStream", async () => {
    const transport = createTransport();
    await transport.sendExecOutput("exec-1", "stdout", "out chunk");
    const body = lastRequestBody();
    expect(body.execId).toBe("exec-1");
    expect(body.execStream).toBe("stdout");
    expect(body.delta).toBe("out chunk");
  });

  test("sendExecComplete posts execExitCode", async () => {
    const transport = createTransport();
    await transport.sendExecComplete("exec-1", 0);
    const body = lastRequestBody();
    expect(body.execId).toBe("exec-1");
    expect(body.execExitCode).toBe(0);
  });

  test("sendExecError posts the error string", async () => {
    const transport = createTransport();
    await transport.sendExecError("exec-1", "boom");
    const body = lastRequestBody();
    expect(body.execId).toBe("exec-1");
    expect(body.error).toBe("boom");
  });

  test("retries on 5xx then succeeds (retryWithBackoff inside sendResponse)", async () => {
    let attempts = 0;
    fetchMock = mock(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("err", { status: 500, statusText: "Server Error" });
      }
      return jsonResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const transport = createTransport();
    await transport.sendStatusUpdate(1, "x");
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test("omits platform / platformMetadata defaults when not configured", async () => {
    const transport = new HttpWorkerTransport({
      ...baseConfig,
      platform: undefined,
      platformMetadata: undefined,
    });
    await transport.sendStreamDelta("x", false, false);
    const body = lastRequestBody();
    expect(body.platform).toBeUndefined();
    expect(body.platformMetadata).toBeUndefined();
  });
});
