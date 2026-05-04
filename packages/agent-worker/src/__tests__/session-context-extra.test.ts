import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getOpenClawSessionContext,
  invalidateSessionContextCache,
} from "../openclaw/session-context";

const originalFetch = globalThis.fetch;
const originalDispatcherUrl = process.env.DISPATCHER_URL;
const originalWorkerToken = process.env.WORKER_TOKEN;

function restoreEnv() {
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
}

beforeEach(() => {
  invalidateSessionContextCache();
  process.env.DISPATCHER_URL = "http://gateway:8080";
  process.env.WORKER_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateSessionContextCache();
  restoreEnv();
});

// ---------------------------------------------------------------------------
// Missing dispatcher URL / worker token → returns defaults (lines 221-223)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — missing env vars", () => {
  test("returns defaults when DISPATCHER_URL is missing", async () => {
    delete process.env.DISPATCHER_URL;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const result = await getOpenClawSessionContext();
    expect(fetchCalled).toBe(false);
    expect(result.agentInstructions).toBe("");
    expect(result.gatewayInstructions).toBe("");
    expect(result.mcpStatus).toEqual([]);
    expect(result.mcpTools).toEqual({});
    expect(result.providerConfig).toEqual({});
    expect(result.skillsConfig).toEqual([]);
  });

  test("returns defaults when WORKER_TOKEN is missing", async () => {
    delete process.env.WORKER_TOKEN;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const result = await getOpenClawSessionContext();
    expect(fetchCalled).toBe(false);
    expect(result.agentInstructions).toBe("");
    expect(result.gatewayInstructions).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Non-success HTTP response → returns defaults (lines 236-240)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — non-success response", () => {
  test("returns defaults when gateway returns 500", async () => {
    globalThis.fetch = async () =>
      new Response("server error", { status: 500 });

    const result = await getOpenClawSessionContext();
    expect(result.agentInstructions).toBe("");
    expect(result.gatewayInstructions).toBe("");
    expect(result.mcpStatus).toEqual([]);
  });

  test("returns defaults when gateway returns 404", async () => {
    globalThis.fetch = async () => new Response("not found", { status: 404 });

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetch throws → returns defaults (lines 316-318)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — fetch errors", () => {
  test("returns defaults when fetch rejects", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const result = await getOpenClawSessionContext();
    expect(result.agentInstructions).toBe("");
    expect(result.gatewayInstructions).toBe("");
    expect(result.mcpStatus).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MCP setup instructions — auth-needed, config-needed, undiscovered branches
// (lines 90-137)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — MCP setup instructions", () => {
  test("includes warning for MCP needing authentication (tools mode)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "github",
              name: "GitHub",
              requiresAuth: true,
              requiresInput: false,
              authenticated: false,
              configured: true,
            },
          ],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toContain("MCP Tools Requiring Setup");
    expect(result.gatewayInstructions).toContain("GitHub");
    expect(result.gatewayInstructions).toContain("github_login");
    expect(result.gatewayInstructions).toContain("github_login_check");
  });

  test("includes warning for MCP needing authentication (cli mode)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "github",
              name: "GitHub",
              requiresAuth: true,
              requiresInput: false,
              authenticated: false,
              configured: true,
            },
          ],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext({ mcpExposure: "cli" });
    expect(result.gatewayInstructions).toContain("Available MCP CLIs");
    expect(result.gatewayInstructions).toContain("github auth login");
    expect(result.gatewayInstructions).toContain("github auth check");
  });

  test("includes warning for MCP needing configuration", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "linear",
              name: "Linear",
              requiresAuth: false,
              requiresInput: true,
              authenticated: true,
              configured: false,
            },
          ],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toContain("Linear");
    expect(result.gatewayInstructions).toContain(
      "Additional MCP input is required"
    );
  });

  test("includes warning for undiscovered MCP (no tools, no auth/input requirement)", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "ghost",
              name: "Ghost",
              requiresAuth: false,
              requiresInput: false,
              authenticated: true,
              configured: true,
            },
          ],
          // ghost is not in mcpTools → undiscovered
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toContain("Ghost");
    expect(result.gatewayInstructions).toContain(
      "No tools were discovered for this MCP"
    );
  });

  test("skips undiscovered warning when MCP requires auth or input", async () => {
    // requiresAuth=true means we already emit the auth warning; the
    // undiscovered loop should `continue` past it. Same for requiresInput.
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "needs-auth",
              name: "NeedsAuth",
              requiresAuth: true,
              requiresInput: false,
              authenticated: false,
              configured: true,
            },
          ],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    // Should appear ONCE (auth warning), not also in undiscovered section.
    const matches = result.gatewayInstructions.match(/NeedsAuth/g) || [];
    expect(matches.length).toBe(1);
  });

  test("returns empty MCP instructions when nothing requires setup", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "happy",
              name: "Happy",
              requiresAuth: false,
              requiresInput: false,
              authenticated: true,
              configured: true,
            },
          ],
          mcpTools: { happy: [{ name: "do_thing" }] },
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).not.toContain(
      "MCP Tools Requiring Setup"
    );
  });
});

// ---------------------------------------------------------------------------
// MCP server instructions (lines 175-178)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — MCP server instructions", () => {
  test("includes server instructions section with each MCP's content", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
          mcpTools: {},
          mcpInstructions: {
            owletto: "Use owletto for memory.",
            github: "Use github for code.",
          },
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toContain("MCP Server Instructions");
    expect(result.gatewayInstructions).toContain("### owletto");
    expect(result.gatewayInstructions).toContain("Use owletto for memory.");
    expect(result.gatewayInstructions).toContain("### github");
    expect(result.gatewayInstructions).toContain("Use github for code.");
  });

  test("filters out MCPs with empty instructions", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
          mcpTools: {},
          mcpInstructions: {
            owletto: "real content",
            empty: "",
          },
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext();
    expect(result.gatewayInstructions).toContain("### owletto");
    expect(result.gatewayInstructions).not.toContain("### empty");
  });
});

// ---------------------------------------------------------------------------
// Cache skip when authenticated MCP returned no tools (lines 304-313)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — cache skip on empty authenticated MCP", () => {
  test("does NOT cache when an authenticated MCP returns no tools", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "github",
              name: "GitHub",
              requiresAuth: true,
              requiresInput: false,
              authenticated: true, // authenticated...
              configured: true,
            },
          ],
          mcpTools: {}, // ...but no tools registered
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await getOpenClawSessionContext();
    await getOpenClawSessionContext();
    // Cache should be skipped → second call must re-fetch.
    expect(fetchCount).toBe(2);
  });

  test("DOES cache when authenticated MCP has tools registered", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "github",
              name: "GitHub",
              requiresAuth: true,
              requiresInput: false,
              authenticated: true,
              configured: true,
            },
          ],
          mcpTools: { github: [{ name: "list_repos" }] },
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await getOpenClawSessionContext();
    await getOpenClawSessionContext();
    expect(fetchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI mode appends MCP CLI header (lines 147-165)
// ---------------------------------------------------------------------------

describe("getOpenClawSessionContext — CLI exposure", () => {
  test("includes MCP CLIs section listing each server when mcpExposure=cli", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [
            {
              id: "owletto",
              name: "Owletto",
              requiresAuth: false,
              requiresInput: false,
              authenticated: true,
              configured: true,
            },
            {
              id: "github",
              name: "GitHub",
              requiresAuth: false,
              requiresInput: false,
              authenticated: true,
              configured: true,
            },
          ],
          mcpTools: {
            owletto: [{ name: "search" }],
            github: [{ name: "list_repos" }],
          },
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext({ mcpExposure: "cli" });
    expect(result.gatewayInstructions).toContain("Available MCP CLIs");
    expect(result.gatewayInstructions).toContain("`owletto`");
    expect(result.gatewayInstructions).toContain("`github`");
    expect(result.gatewayInstructions).toContain("--schema");
  });

  test("CLI mode with empty mcpStatus produces no CLI header", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

    const result = await getOpenClawSessionContext({ mcpExposure: "cli" });
    expect(result.gatewayInstructions).not.toContain("Available MCP CLIs");
  });

  test("cache key includes mcpExposure — switching mode forces re-fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          agentInstructions: "",
          platformInstructions: "",
          networkInstructions: "",
          skillsInstructions: "",
          mcpStatus: [],
          mcpTools: {},
          mcpInstructions: {},
          mcpContext: {},
          providerConfig: {},
          skillsConfig: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await getOpenClawSessionContext({ mcpExposure: "tools" });
    await getOpenClawSessionContext({ mcpExposure: "cli" });
    expect(fetchCount).toBe(2);
  });
});
