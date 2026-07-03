import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildWorkerJourneyEventBody,
  emitJourneyObservabilityEvent,
} from "../shared/journey-observability";

const OBS_ENV_KEYS = [
  "TOOLBOX_AGENT_OBSERVABILITY_URL",
  "TOOLBOX_INTERNAL_SECRET",
] as const;

const originalEnv = new Map<string, string | undefined>();
let originalFetch: typeof globalThis.fetch;

function restoreObsEnv() {
  for (const key of OBS_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("worker journey observability", () => {
  beforeEach(() => {
    for (const key of OBS_ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreObsEnv();
    globalThis.fetch = originalFetch;
  });

  test("builds Task 5 journey wrapper bodies and redacts sensitive fields", () => {
    const body = buildWorkerJourneyEventBody({
      event: "mcp.tool_call.started",
      trace: {
        traceId: "tr_workerwrapper",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "started",
      fields: {
        tool: { name: "calendar_events_list" },
        authorization: "abc123",
        line_user_id: "U-line-secret",
        toolbox: { user_id: "toolbox-user-secret" },
        agent: { id: "agent-public-but-still-identity" },
        conversation: { id: "conversation-public-but-still-identity" },
      },
    });

    expect(body).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "mcp.tool_call.started",
        trace_id: "tr_workerwrapper",
        journey_id: "line_reply",
        service: "lobu",
        module: "agent-worker",
        status: "started",
        tool: { name: "calendar_events_list" },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("U-line-secret");
    expect(serialized).not.toContain("toolbox-user-secret");
    expect(serialized).not.toContain("agent-public-but-still-identity");
    expect(serialized).not.toContain("conversation-public-but-still-identity");
    expect(body.payload).toMatchObject({
      trace_id: "tr_workerwrapper",
      toolbox: { user_id: "[REDACTED]" },
      agent: { id: "[REDACTED]" },
      conversation: { id: "[REDACTED]" },
    });
  });

  test("posts wrapper bodies to Toolbox with fail-open timeout behavior", async () => {
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    let sawAbort = false;
    const fetchMock = mock((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal instanceof AbortSignal) {
          signal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      Promise.race([
        emitJourneyObservabilityEvent({
          event: "lobu.worker.started",
          trace: {
            traceId: "tr_worker_timeout",
            journeyId: "line_reply",
            actor: "worker",
            traceSource: "incoming",
          },
          status: "started",
        }).then(() => "resolved"),
        Bun.sleep(1000).then(() => "timed-out"),
      ])
    ).resolves.toBe("resolved");

    expect(sawAbort).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://toolbox.example.test/ingest");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-internal-secret": "internal-secret",
    });
  });

  test("does not fetch when endpoint or secret is missing", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitJourneyObservabilityEvent({
      event: "lobu.worker.started",
      trace: {
        traceId: "tr_worker_missing_config",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "started",
    });

    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    await emitJourneyObservabilityEvent({
      event: "lobu.worker.started",
      trace: {
        traceId: "tr_worker_missing_secret",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "started",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
