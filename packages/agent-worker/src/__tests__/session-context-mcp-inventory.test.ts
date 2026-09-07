import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __resetEncryptionKeyCacheForTests,
  generateWorkerToken,
  type McpStatus,
  type McpToolDef,
} from "@lobu/core";
import {
  buildMcpToolInventoryInstructions,
  getOpenClawSessionContext,
  invalidateSessionContextCache,
} from "../openclaw/session-context";

function tool(name: string): McpToolDef {
  return { name, description: "", inputSchema: { type: "object" } };
}

const mcpStatus: McpStatus[] = [];
const originalDispatcherUrl = process.env.DISPATCHER_URL;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

describe("buildMcpToolInventoryInstructions capability notes", () => {
  afterEach(() => {
    mock.restore();
    if (originalDispatcherUrl === undefined) {
      delete process.env.DISPATCHER_URL;
    } else {
      process.env.DISPATCHER_URL = originalDispatcherUrl;
    }
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
    __resetEncryptionKeyCacheForTests();
    invalidateSessionContextCache();
  });

  test("notion entry includes the delete/archive/trash capability limit", () => {
    const output = buildMcpToolInventoryInstructions(
      { notion: [tool("notion-update-page"), tool("notion-search")] },
      mcpStatus
    );

    expect(output).toContain("CANNOT delete, archive, or trash");
    expect(output).toContain("Capability limits:");
  });

  test("google_workspace entry includes its capability limit note", () => {
    const output = buildMcpToolInventoryInstructions(
      { google_workspace: [tool("gws-drive-search")] },
      mcpStatus
    );

    expect(output).toContain(
      "CANNOT delete or trash Docs/Sheets/Slides/Drive files"
    );
  });

  test("MCPs not in the capability notes map get no Capability limits line", () => {
    const output = buildMcpToolInventoryInstructions(
      { "shifu-toolbox": [tool("run_sql")] },
      mcpStatus
    );

    expect(output).toContain("shifu-toolbox");
    expect(output).not.toContain("Capability limits:");
  });

  test("session context defers raw MCP and Toolbox names until effective inventory exists", async () => {
    process.env.DISPATCHER_URL = "https://gateway.test";
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    globalThis.fetch = mock(async () =>
      Response.json({
        userId: "user-1",
        agentId: "agent-1",
        agentInstructions: "identity",
        platformInstructions: "platform",
        networkInstructions: "network",
        skillsInstructions: "skills",
        mcpStatus: [],
        mcpTools: { secret: [tool("search_payroll")] },
        toolboxPersonalAgentTools: [
          {
            connectorKey: "shifu_toolbox",
            connectionRef: "connection-1",
            tools: [
              {
                name: "private_writeback",
                connectorToolName: "private_writeback",
                description: "private",
                inputSchema: { type: "object" },
              },
            ],
          },
        ],
      })
    ) as typeof fetch;

    const workerToken = generateWorkerToken(
      "user-1",
      "conversation-1",
      "deploy",
      {
        channelId: "line-1",
        agentId: "agent-1",
      }
    );
    const context = await getOpenClawSessionContext({ workerToken });

    expect(context.gatewayInstructions).not.toContain("search_payroll");
    expect(context.gatewayInstructions).not.toContain("private_writeback");
    expect(context.mcpTools.secret?.[0]?.name).toBe("search_payroll");
    expect(context.toolboxPersonalAgentTools[0]?.tools[0]?.name).toBe(
      "private_writeback"
    );
  });

  test("degraded MCP auth status does not generate start-login setup guidance", async () => {
    process.env.DISPATCHER_URL = "https://gateway.test";
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    __resetEncryptionKeyCacheForTests();
    globalThis.fetch = mock(async () =>
      Response.json({
        userId: "user-1",
        agentId: "agent-1",
        agentInstructions: "identity",
        platformInstructions: "platform",
        networkInstructions: "network",
        skillsInstructions: "skills",
        mcpStatus: [
          {
            id: "shifu-toolbox",
            name: "ShiFu Toolbox",
            requiresAuth: true,
            authenticated: false,
            authStatus: "degraded",
            diagnosticCode: "auth_required_zero_tools",
            configured: true,
          },
        ],
        mcpTools: {},
      })
    ) as typeof fetch;

    const workerToken = generateWorkerToken(
      "user-1",
      "conversation-1",
      "deploy",
      {
        channelId: "line-1",
        agentId: "agent-1",
      }
    );
    const context = await getOpenClawSessionContext({ workerToken });

    expect(context.gatewayInstructions).toContain("temporarily degraded");
    expect(context.gatewayInstructions).toContain("try again later");
    expect(context.gatewayInstructions).not.toContain("To start login");
    expect(context.gatewayInstructions).not.toContain("auth login");
  });
});
