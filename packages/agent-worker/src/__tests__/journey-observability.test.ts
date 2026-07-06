import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildWorkerJourneyEventBody,
  emitJourneyObservabilityEvent,
} from "../shared/journey-observability";

const OBS_ENV_KEYS = [
  "TOOLBOX_AGENT_OBSERVABILITY_URL",
  "TOOLBOX_INTERNAL_SECRET",
  "SHIFU_AGENT_OBS_ENABLED",
  "SHIFU_AGENT_OBS_INGEST_URL",
  "SHIFU_AGENT_OBS_TOKEN",
  "SHIFU_AGENT_OBS_SOURCE",
  "SHIFU_AGENT_OBS_TIMEOUT_MS",
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

  test("promotes safe conversation and session ids for Toolbox trace lookup", () => {
    const body = buildWorkerJourneyEventBody({
      event: "lobu.worker.started",
      trace: {
        traceId: "tr_worker_context",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "started",
      fields: {
        conversation: { id: "conv-lookup-1" },
        session: { key: "session-lookup-1" },
      },
    });

    expect(body.payload).toMatchObject({
      trace_id: "tr_worker_context",
      event: "lobu.worker.started",
      conversation_id: "conv-lookup-1",
      session_id: "session-lookup-1",
      conversation: { id: "[REDACTED]" },
    });
  });

  test("posts wrapper bodies to Toolbox with fail-open timeout behavior", async () => {
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    let sawAbort = false;
    const fetchMock = mock(
      (_url: string | URL | Request, init?: RequestInit) => {
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
      }
    );
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

  test("posts wrapper bodies with SHIFU Agent Obs env without legacy Toolbox secret", async () => {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    process.env.SHIFU_AGENT_OBS_TOKEN = "agent-obs-token";
    process.env.SHIFU_AGENT_OBS_SOURCE = "lobu-worker";
    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitJourneyObservabilityEvent({
      event: "provider.call.started",
      trace: {
        traceId: "tr_worker_shifu_only",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "started",
      fields: {
        provider: { name: "openai" },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://obs.example.test/ingest");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer agent-obs-token",
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      schemaVersion: "journey.trace.v1",
      source: "lobu-worker",
      payload: {
        trace_id: "tr_worker_shifu_only",
        journey_id: "line_reply",
        event: "provider.call.started",
        service: "lobu",
        module: "agent-worker",
        status: "started",
        provider: { name: "openai" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("agent-obs-token");
  });

  test("prefers SHIFU Agent Obs transport over legacy Toolbox config when enabled", async () => {
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await emitJourneyObservabilityEvent({
      event: "provider.call.completed",
      trace: {
        traceId: "tr_worker_dual_config",
        journeyId: "line_reply",
        actor: "worker",
        traceSource: "incoming",
      },
      status: "ok",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://obs.example.test/ingest");
    expect(init.headers).toEqual({
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      schemaVersion: "journey.trace.v1",
      source: "lobu",
      payload: {
        trace_id: "tr_worker_dual_config",
        event: "provider.call.completed",
      },
    });
    expect(JSON.stringify(body)).not.toContain("internal-secret");
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
