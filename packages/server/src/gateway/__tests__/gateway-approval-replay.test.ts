import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  buildPendingToolExecutionOptions,
  storePendingTool,
  type PendingToolInvocation,
} from "../auth/mcp/pending-tool-store.js";
import { createGatewayApp } from "../cli/gateway.js";
import { ensureDbForGatewayTests, resetTestDatabase } from "./helpers/db-setup.js";

const AUTH_TOKEN = "gateway-approval-test-token";

function makeApp(executeToolDirect: ReturnType<typeof mock>) {
  const grant = mock(async () => undefined);
  const empty = () => undefined;
  const coreServices = {
    getPublicGatewayUrl: () => "https://lobu.example",
    getQueueProducer: () => ({ enqueueMessage: mock(async () => "job-1") }),
    getSessionManager: () => ({
      getSession: mock(async () => null),
      touchSession: mock(async () => undefined),
    }),
    getInteractionService: () => ({}),
    getSseManager: () => ({}),
    getAgentMetadataStore: empty,
    getTranscriptionService: empty,
    getBedrockOpenAIService: empty,
    getSecretStore: empty,
    getMcpConfigService: empty,
    getImageGenerationService: empty,
    getGrantStore: () => ({ grant }),
    getMcpProxy: () => ({ executeToolDirect }),
    getExternalAuthClient: empty,
    getAgentSettingsStore: empty,
    getConfigStore: empty,
    getUserAgentsStore: empty,
    getAuthProfilesManager: empty,
    getOAuthStateStore: empty,
    getProviderRegistryService: empty,
    getWorkerGateway: empty,
    getQueue: empty,
    getProviderCatalogService: empty,
    getChannelBindingService: empty,
  };
  return createGatewayApp({
    secretProxy: null,
    workerGateway: null,
    mcpProxy: null,
    coreServices,
    authProvider: (c) =>
      c.req.header("authorization") === `Bearer ${AUTH_TOKEN}`
        ? {
            userId: "user-1",
            organizationId: "org-1",
            platform: "api",
            exp: Date.now() + 60_000,
          }
        : null,
  });
}

async function approve(app: ReturnType<typeof makeApp>, requestId: string) {
  return app.request("/api/v1/agents/approve", {
    method: "POST",
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId, decision: "1h" }),
  });
}

describe("CLI gateway pending-tool approval replay", () => {
  beforeAll(async () => ensureDbForGatewayTests());
  beforeEach(async () => resetTestDatabase());

  test("reserved automation approval forwards identity, channel, and existing course scope", async () => {
    const expectedMcpIdentity = {
      upstreamOrigin: "https://mcp.shifu-ai.org",
      configSource: "agent" as const,
      configDigest: "digest-at-discovery",
    };
    const courseToolScope = {
      ownerUserId: "user-1",
      agentId: "agent-1",
      courseEntityId: "course:user-1:a",
    };
    await storePendingTool(
      "cli-reserved-success",
      {
        mcpId: "shifu-toolbox",
        toolName: "create_automation",
        args: { prompt: "提醒 Irene" },
        agentId: "agent-1",
        userId: "user-1",
        channelId: "line-user-1",
        courseToolScope,
        expectedMcpIdentity,
      },
      60
    );
    const executeToolDirect = mock(async () => ({
      content: [{ type: "text", text: "created" }],
      isError: false,
    }));

    const response = await approve(makeApp(executeToolDirect), "cli-reserved-success");

    expect(response.status).toBe(200);
    expect(executeToolDirect).toHaveBeenCalledWith(
      "agent-1",
      "user-1",
      "shifu-toolbox",
      "create_automation",
      { prompt: "提醒 Irene" },
      { courseToolScope, expectedMcpIdentity, channelId: "line-user-1" }
    );
  });

  test("returns the reserved-tool config mismatch without retrying or dropping channel scope", async () => {
    const expectedMcpIdentity = {
      upstreamOrigin: "https://mcp.shifu-ai.org",
      configSource: "agent" as const,
      configDigest: "stale-digest",
    };
    await storePendingTool(
      "cli-reserved-stale",
      {
        mcpId: "shifu-toolbox",
        toolName: "list_automations",
        args: {},
        agentId: "agent-1",
        userId: "user-1",
        channelId: "line-user-1",
        expectedMcpIdentity,
      },
      60
    );
    const mismatch = {
      content: [
        {
          type: "text",
          text: "MCP configuration changed after tool discovery.",
        },
      ],
      isError: true,
      diagnosticCode: "MCP_CONFIG_IDENTITY_MISMATCH",
    };
    const executeToolDirect = mock(async () => mismatch);

    const response = await approve(makeApp(executeToolDirect), "cli-reserved-stale");

    expect(response.status).toBe(200);
    expect(executeToolDirect).toHaveBeenCalledTimes(1);
    expect(executeToolDirect).toHaveBeenCalledWith(
      "agent-1",
      "user-1",
      "shifu-toolbox",
      "list_automations",
      {},
      { expectedMcpIdentity, channelId: "line-user-1" }
    );
  });

  test("legacy pending rows omit the options argument instead of forwarding undefined fields", () => {
    const legacy: PendingToolInvocation = {
      mcpId: "github",
      toolName: "read_issue",
      args: {},
      agentId: "agent-1",
      userId: "user-1",
    };
    expect(buildPendingToolExecutionOptions(legacy)).toBeUndefined();
  });
});
