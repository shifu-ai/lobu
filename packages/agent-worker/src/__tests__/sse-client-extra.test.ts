import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  GatewayClient,
  consumePendingConfigNotifications,
} from "../gateway/sse-client";

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(): Response {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(): GatewayClient {
  return new GatewayClient(
    "https://gw.example.com",
    "tok-1",
    "user-1",
    "deployment-1"
  );
}

describe("consumePendingConfigNotifications", () => {
  test("returns [] when nothing has been queued and is idempotent", () => {
    // Drain anything left over from earlier tests in the same file.
    consumePendingConfigNotifications();
    expect(consumePendingConfigNotifications()).toEqual([]);
    expect(consumePendingConfigNotifications()).toEqual([]);
  });
});

describe("GatewayClient.handleEvent (private, exercised via cast)", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    consumePendingConfigNotifications();
    fetchMock = mock(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("'connected' event with valid payload is processed silently (no fetch)", async () => {
    const client = makeClient();
    await (client as any).handleEvent(
      "connected",
      JSON.stringify({ deploymentName: "deployment-1" })
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("'connected' event with invalid payload swallows the error (try/catch)", async () => {
    const client = makeClient();
    // Missing required deploymentName — Zod fails. handleEvent's outer try/catch
    // logs the error rather than propagating.
    await expect(
      (client as any).handleEvent("connected", JSON.stringify({}))
    ).resolves.toBeUndefined();
  });

  test("'ping' event triggers a heartbeat ACK POST", async () => {
    const client = makeClient();
    await (client as any).handleEvent("ping", "{}");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gw.example.com/worker/response");
    const initObj = init as RequestInit;
    expect(initObj.method).toBe("POST");
    expect(initObj.body).toBe(
      JSON.stringify({ received: true, heartbeat: true })
    );
  });

  test("'config_changed' queues notifications for the next prompt", async () => {
    const client = makeClient();
    await (client as any).handleEvent(
      "config_changed",
      JSON.stringify({
        changes: [
          {
            category: "skills",
            action: "added",
            summary: "added skill X",
          },
          {
            category: "tools",
            action: "removed",
            summary: "removed tool Y",
            details: ["was risky"],
          },
        ],
      })
    );

    const queued = consumePendingConfigNotifications();
    expect(queued).toHaveLength(2);
    expect(queued[0]?.category).toBe("skills");
    expect(queued[1]?.summary).toBe("removed tool Y");
    // Drained now.
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("'config_changed' with malformed JSON is tolerated (no throw)", async () => {
    const client = makeClient();
    await expect(
      (client as any).handleEvent("config_changed", "not-json")
    ).resolves.toBeUndefined();
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("'config_changed' with no changes array queues nothing", async () => {
    const client = makeClient();
    await (client as any).handleEvent(
      "config_changed",
      JSON.stringify({ other: "data" })
    );
    expect(consumePendingConfigNotifications()).toEqual([]);
  });

  test("unknown event type logs warning but does not throw", async () => {
    const client = makeClient();
    await expect(
      (client as any).handleEvent("totally-unknown", "{}")
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("'job' event with invalid payload is swallowed (no throw)", async () => {
    const client = makeClient();
    await expect(
      (client as any).handleEvent(
        "job",
        JSON.stringify({ payload: { not: "valid" } })
      )
    ).resolves.toBeUndefined();
    // No outbound fetch (no jobId on top level, validation failed before).
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("'job' event with valid payload + top-level jobId fires a delivery receipt", async () => {
    const client = makeClient();
    const validPayload = {
      jobId: "job-top-1",
      payload: {
        botId: "b1",
        userId: "u1",
        agentId: "a1",
        conversationId: "c1",
        platform: "slack",
        channelId: "C1",
        messageId: "m1",
        messageText: "hello",
        platformMetadata: {},
        agentOptions: {},
        jobId: "job-top-1",
      },
    };

    // handleEvent calls handleThreadMessage which queues a message in the batcher.
    // The first message in a brand-new batcher flushes immediately, which calls
    // processBatchedMessages -> processSingleMessage -> dynamic import of the
    // OpenClawWorker module. We don't want to actually run that, so we let the
    // promise reject and assert only on the synchronous delivery receipt.
    let receiptSent = false;
    fetchMock = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/worker/response")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          if (body.received === true && body.jobId === "job-top-1") {
            receiptSent = true;
          }
        }
        return jsonResponse();
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // We don't await — handleThreadMessage will try to dynamically import the
    // OpenClaw worker which may or may not succeed. We only care that the
    // delivery receipt POST happened synchronously up front.
    void (client as any)
      .handleEvent("job", JSON.stringify(validPayload))
      .catch(() => {
        /* swallow */
      });

    // Yield to let the fire-and-forget receipt POST schedule.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receiptSent).toBe(true);

    // Stop the client to cancel any in-flight reconnect/processing.
    await client.stop();
  });
});

describe("GatewayClient lifecycle", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("isHealthy() is false until start() and after stop()", async () => {
    const client = makeClient();
    expect(client.isHealthy()).toBe(false);
    await client.stop();
    expect(client.isHealthy()).toBe(false);
  });

  test("getStatus() reports the configured user/deployment and zero pending", () => {
    const client = makeClient();
    const status = client.getStatus();
    expect(status.userId).toBe("user-1");
    expect(status.deploymentName).toBe("deployment-1");
    expect(status.pendingMessages).toBe(0);
    expect(status.isProcessing).toBe(false);
    expect(status.isRunning).toBe(false);
  });

  test("stop() is safe to call when nothing is running", async () => {
    const client = makeClient();
    await expect(client.stop()).resolves.toBeUndefined();
    // Calling twice is also safe.
    await expect(client.stop()).resolves.toBeUndefined();
  });

  test("constructor with httpPort still constructs cleanly", () => {
    const client = new GatewayClient(
      "https://gw.example.com",
      "tok-1",
      "user-1",
      "deployment-1",
      4321
    );
    expect(client.getStatus().deploymentName).toBe("deployment-1");
  });
});

describe("GatewayClient.handleExecJob", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  test("missing execId or execCommand returns early without throwing", async () => {
    const client = makeClient();
    await expect(
      (client as any).handleExecJob({
        botId: "b",
        userId: "u",
        agentId: "a",
        conversationId: "c",
        platform: "p",
        channelId: "ch",
        messageId: "m",
        messageText: "",
        platformMetadata: {},
        agentOptions: {},
        jobType: "exec",
        // execId/execCommand omitted
      })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("runs a real /bin/echo command and posts stdout + completion", async () => {
    const client = makeClient();
    const seenBodies: any[] = [];
    fetchMock = mock(async (_url, init?: RequestInit) => {
      if (init?.body) {
        try {
          seenBodies.push(JSON.parse(init.body as string));
        } catch {
          // ignore
        }
      }
      return jsonResponse();
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await (client as any).handleExecJob({
      botId: "b",
      userId: "u",
      agentId: "a",
      conversationId: "c",
      platform: "p",
      channelId: "ch",
      messageId: "m",
      messageText: "",
      platformMetadata: {},
      agentOptions: {},
      jobType: "exec",
      execId: "exec-1",
      execCommand: "echo hello-from-test",
      execCwd: process.cwd(),
      execTimeout: 5000,
    });

    // We expect at least: stdout chunk + completion.
    const stdoutBody = seenBodies.find(
      (b) => b?.execStream === "stdout" && typeof b?.delta === "string"
    );
    const completeBody = seenBodies.find(
      (b) => b?.execId === "exec-1" && typeof b?.execExitCode === "number"
    );

    expect(stdoutBody).toBeTruthy();
    expect(stdoutBody.delta).toContain("hello-from-test");
    expect(completeBody).toBeTruthy();
    expect(completeBody.execExitCode).toBe(0);
  });
});
