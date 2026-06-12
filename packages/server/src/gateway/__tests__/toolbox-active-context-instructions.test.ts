import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InstructionContext } from "@lobu/core";
import {
  BaseInstructionProvider,
  InstructionService,
} from "../services/instruction-service.js";

const originalFetch = globalThis.fetch;
const originalActiveContextUrl = process.env.TOOLBOX_ACTIVE_CONTEXT_URL;
const originalInternalSecret = process.env.TOOLBOX_INTERNAL_SECRET;

class TestPlatformInstructionProvider extends BaseInstructionProvider {
  readonly name = "test-platform";
  readonly priority = 10;

  protected buildInstructions(): string {
    return "## Platform Context\n\nExisting platform instructions.";
  }
}

const context: InstructionContext = {
  agentId: "shifu-u-agent-1",
  userId: "toolbox-user-1",
  sessionKey: "session-1",
  workingDirectory: "/workspace/session-1",
};

function configureToolboxEnv() {
  process.env.TOOLBOX_ACTIVE_CONTEXT_URL =
    "https://toolbox.example/internal/active-context";
  process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
}

function restoreEnv() {
  if (originalActiveContextUrl === undefined) {
    delete process.env.TOOLBOX_ACTIVE_CONTEXT_URL;
  } else {
    process.env.TOOLBOX_ACTIVE_CONTEXT_URL = originalActiveContextUrl;
  }

  if (originalInternalSecret === undefined) {
    delete process.env.TOOLBOX_INTERNAL_SECRET;
  } else {
    process.env.TOOLBOX_INTERNAL_SECRET = originalInternalSecret;
  }
}

function createService() {
  const service = new InstructionService();
  service.registerPlatformProvider(
    "test",
    new TestPlatformInstructionProvider()
  );
  return service;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("Toolbox active context instructions", () => {
  beforeEach(() => {
    restoreEnv();
  });

  test("injects compact active project context from Toolbox", async () => {
    configureToolboxEnv();
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          contextPack: {
            title: "ShiFu LINE Agent",
            summary: "Wire LINE replies to the user's personal Lobu agent.",
            confidence: "high",
            importantArtifacts: [
              {
                title: "Gateway handoff",
                preview: "Use the staging Toolbox route endpoint.",
                source: "handoff",
                url: "https://example.com/handoff",
              },
            ],
            memoryWriteRefs: [],
            createdAt: "2026-06-12T00:00:00.000Z",
          },
          run: { id: "run-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const sessionContext = await createService().getSessionContext(
      "test",
      context
    );

    expect(sessionContext.platformInstructions).toContain(
      "## Platform Context"
    );
    expect(sessionContext.platformInstructions).toContain(
      "## Active Project Context"
    );
    expect(sessionContext.platformInstructions).toContain(
      "Project: ShiFu LINE Agent"
    );
    expect(sessionContext.platformInstructions).toContain("Confidence: high");
    expect(sessionContext.platformInstructions).toContain(
      "Summary: Wire LINE replies to the user's personal Lobu agent."
    );
    expect(sessionContext.platformInstructions).toContain(
      "- Gateway handoff [handoff]: Use the staging Toolbox route endpoint. (https://example.com/handoff)"
    );
    expect(sessionContext.platformInstructions).toContain(
      "Use this context as the current user's active project background."
    );
  });

  test("calls Toolbox with owner user, agent, and internal secret", async () => {
    configureToolboxEnv();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          contextPack: {
            title: "Project",
            summary: "Summary",
            confidence: "medium",
            importantArtifacts: [],
          },
          run: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createService().getSessionContext("test", context);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe(
      "https://toolbox.example/internal/active-context?ownerUserId=toolbox-user-1&agentId=shifu-u-agent-1"
    );
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ "X-Internal-Secret": "internal-secret" });
  });

  test("fails open when Toolbox returns a non-2xx response", async () => {
    configureToolboxEnv();
    globalThis.fetch = mock(async () => {
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const sessionContext = await createService().getSessionContext(
      "test",
      context
    );

    expect(sessionContext.platformInstructions).toContain(
      "## Platform Context"
    );
    expect(sessionContext.platformInstructions).not.toContain(
      "## Active Project Context"
    );
  });

  test("fails open when Toolbox fetch throws", async () => {
    configureToolboxEnv();
    globalThis.fetch = mock(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof fetch;

    const sessionContext = await createService().getSessionContext(
      "test",
      context
    );

    expect(sessionContext.platformInstructions).not.toContain(
      "## Active Project Context"
    );
  });

  test("returns no active project context when env vars are missing", async () => {
    delete process.env.TOOLBOX_ACTIVE_CONTEXT_URL;
    delete process.env.TOOLBOX_INTERNAL_SECRET;
    const fetchMock = mock(async () => {
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const sessionContext = await createService().getSessionContext(
      "test",
      context
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionContext.platformInstructions).not.toContain(
      "## Active Project Context"
    );
  });

  test("returns no active project context when Toolbox has no context pack", async () => {
    configureToolboxEnv();
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ contextPack: null, run: null }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const sessionContext = await createService().getSessionContext(
      "test",
      context
    );

    expect(sessionContext.platformInstructions).not.toContain(
      "## Active Project Context"
    );
  });
});
