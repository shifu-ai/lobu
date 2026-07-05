import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  buildLobuSystemPrompt,
  runModelWithObs,
  replaceBasePromptIdentity,
} from "../openclaw/worker";

const PI_OPENER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const originalFetch = globalThis.fetch;
const originalObsEnv = {
  enabled: process.env.SHIFU_AGENT_OBS_ENABLED,
  ingestUrl: process.env.SHIFU_AGENT_OBS_INGEST_URL,
  token: process.env.SHIFU_AGENT_OBS_TOKEN,
  toolboxUrl: process.env.TOOLBOX_AGENT_OBSERVABILITY_URL,
  toolboxSecret: process.env.TOOLBOX_INTERNAL_SECRET,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalObsEnv.enabled === undefined) {
    delete process.env.SHIFU_AGENT_OBS_ENABLED;
  } else {
    process.env.SHIFU_AGENT_OBS_ENABLED = originalObsEnv.enabled;
  }
  if (originalObsEnv.ingestUrl === undefined) {
    delete process.env.SHIFU_AGENT_OBS_INGEST_URL;
  } else {
    process.env.SHIFU_AGENT_OBS_INGEST_URL = originalObsEnv.ingestUrl;
  }
  if (originalObsEnv.token === undefined) {
    delete process.env.SHIFU_AGENT_OBS_TOKEN;
  } else {
    process.env.SHIFU_AGENT_OBS_TOKEN = originalObsEnv.token;
  }
  if (originalObsEnv.toolboxUrl === undefined) {
    delete process.env.TOOLBOX_AGENT_OBSERVABILITY_URL;
  } else {
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL = originalObsEnv.toolboxUrl;
  }
  if (originalObsEnv.toolboxSecret === undefined) {
    delete process.env.TOOLBOX_INTERNAL_SECRET;
  } else {
    process.env.TOOLBOX_INTERNAL_SECRET = originalObsEnv.toolboxSecret;
  }
  mock.restore();
});

describe("replaceBasePromptIdentity", () => {
  test("replaces the pi-coding-agent opener with agent identity, preserving the rest", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read: Read file contents\n\nGuidelines:\n- Be concise`;
    const identity = "You are a healthcare operations assistant.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    expect(out).not.toContain("expert coding assistant");
    // Preserved harness footer
    expect(out).toContain("Available tools:");
    expect(out).toContain("Guidelines:");
  });

  test("falls back to prepending identity when upstream opener wording drifts", () => {
    const base =
      "You are some other intro that the upstream package switched to.\n\nAvailable tools:\n- read";
    const identity = "You are a healthcare operations assistant.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    // Original base prompt is still there (we didn't accidentally drop it)
    expect(out).toContain("Available tools:");
    expect(out).toContain("some other intro");
  });

  test("multi-line identity is inserted as a single block", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read`;
    const identity =
      "You are a careops bot.\n\nYou speak only in plain English.";
    const out = replaceBasePromptIdentity(base, identity);

    expect(out.startsWith(identity)).toBe(true);
    expect(out).toContain("Available tools:");
  });

  test("builds the Lobu base system prompt before the session starts", () => {
    const base = `${PI_OPENER}\n\nAvailable tools:\n- read`;
    const identity = "## Agent Identity\n\nYou are ShiFu onboarding agent.";
    const gateway = "## Conversation History\n\nUse get_channel_history.";
    const out = buildLobuSystemPrompt(base, identity, gateway);

    expect(out.startsWith(identity)).toBe(true);
    expect(out).not.toContain("expert coding assistant");
    expect(out).toContain("Available tools:");
    expect(out).toContain("---");
    expect(out).toContain(gateway);
  });
});

describe("worker model observability", () => {
  function enableObs(fetchMock: ReturnType<typeof mock>) {
    process.env.SHIFU_AGENT_OBS_ENABLED = "true";
    process.env.SHIFU_AGENT_OBS_INGEST_URL = "https://obs.example.test/ingest";
    delete process.env.SHIFU_AGENT_OBS_TOKEN;
    process.env.TOOLBOX_AGENT_OBSERVABILITY_URL =
      "https://toolbox.example.test/ingest";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  const obsBase = {
    trace: {
      traceId: "tr_modelobs123456",
      journeyId: "line_reply",
      turnId: "turn_modelobs123",
      actor: "worker",
      traceSource: "incoming" as const,
    },
    conversationId: "conv-1",
    agentId: "agent-1",
    userId: "user-1",
    provider: "openai",
    modelId: "gpt-4.1",
    toolCount: 7,
  };

  test("does not wait for model observability ingest responses", async () => {
    const pendingFetches: Array<() => void> = [];
    const fetchMock = mock(
      () =>
        new Promise<Response>((resolve) => {
          pendingFetches.push(() =>
            resolve(new Response("{}", { status: 202 }))
          );
        })
    );
    enableObs(fetchMock);

    let runnerCalled = false;
    let runSettled = false;
    const runPromise = runModelWithObs(obsBase, async () => {
      runnerCalled = true;
      return { success: true, outputChars: 42 };
    });
    runPromise.then(() => {
      runSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    const runnerCalledBeforeStartedIngestSettled = runnerCalled;

    if (!runnerCalled) {
      pendingFetches[0]?.();
      for (let i = 0; i < 5 && pendingFetches.length < 2; i++) {
        await Promise.resolve();
      }
    }
    const runSettledBeforeCompletedIngestSettled = runSettled;

    for (const settle of pendingFetches) {
      settle();
    }
    for (let i = 0; i < 5 && !runSettled; i++) {
      await Promise.resolve();
      for (const settle of pendingFetches) {
        settle();
      }
    }
    await runPromise;

    expect(runnerCalledBeforeStartedIngestSettled).toBe(true);
    expect(runSettledBeforeCompletedIngestSettled).toBe(true);
  });

  test("emits canonical Lobu model journey events around a successful runner", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    enableObs(fetchMock);

    await runModelWithObs(obsBase, async () => ({
      success: true,
      outputChars: 42,
    }));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstCall = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(firstCall[0]).toBe("https://toolbox.example.test/ingest");
    expect(firstCall[1].headers).toEqual({
      "content-type": "application/json",
      "x-internal-secret": "internal-secret",
    });
    const events = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
    );
    expect(events[0]).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "lobu.model.started",
        trace_id: "tr_modelobs123456",
        journey_id: "line_reply",
        service: "lobu",
        module: "agent-worker",
        status: "started",
        provider: {
          name: "openai",
          model: "gpt-4.1",
        },
        tool: {
          count: 7,
        },
      },
    });
    expect(events[1]).toMatchObject({
      eventName: "lobu.model.started",
      status: "started",
      stage: "lobu.model.started",
      metadata: {
        module: "agent-worker",
        provider: "openai",
        model: "gpt-4.1",
        tool_count: 7,
      },
    });
    expect(events[2]).toMatchObject({
      schemaVersion: "journey.trace.v1",
      payload: {
        schema_version: "journey.trace.v1",
        event: "lobu.model.completed",
        trace_id: "tr_modelobs123456",
        journey_id: "line_reply",
        service: "lobu",
        module: "agent-worker",
        status: "ok",
        provider: {
          name: "openai",
          model: "gpt-4.1",
        },
        output_chars: 42,
      },
    });
    expect(events[3]).toMatchObject({
      eventName: "lobu.model.completed",
      status: "ok",
      stage: "lobu.model.completed",
      metadata: {
        module: "agent-worker",
        provider: "openai",
        model: "gpt-4.1",
        output_chars: 42,
      },
    });
    expect(typeof events[3].durationMs).toBe("number");
  });

  test("emits model failed event when the runner throws", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 202 }));
    enableObs(fetchMock);

    await expect(
      runModelWithObs(obsBase, async () => {
        throw new Error("provider rejected model request");
      })
    ).rejects.toThrow("provider rejected model request");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const failed = JSON.parse(
      String(
        (fetchMock.mock.calls[3] as unknown as [string, RequestInit])[1].body
      )
    );
    expect(failed).toMatchObject({
      eventName: "lobu.model.failed",
      status: "failed",
      stage: "lobu.model.failed",
      metadata: {
        module: "agent-worker",
        provider: "openai",
        model: "gpt-4.1",
        error_class: "model_error",
      },
    });
    expect(failed.metadata.next_debug_hint).toContain("model");
    expect(typeof failed.durationMs).toBe("number");
  });
});
