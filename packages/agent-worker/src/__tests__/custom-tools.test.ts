import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "../openclaw/custom-tools";
import {
  projectMcpToolsForProvider,
  projectToolParametersForProvider,
} from "../openclaw/mcp-tool-projection";
import { findDuplicateToolNames } from "../openclaw/session-runner";

const originalFetch = globalThis.fetch;
const originalProjectDiscoveryUrl = process.env.TOOLBOX_PROJECT_DISCOVERY_URL;
const originalInternalSecret = process.env.TOOLBOX_INTERNAL_SECRET;

describe("createOpenClawCustomTools", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalProjectDiscoveryUrl === undefined) {
      delete process.env.TOOLBOX_PROJECT_DISCOVERY_URL;
    } else {
      process.env.TOOLBOX_PROJECT_DISCOVERY_URL = originalProjectDiscoveryUrl;
    }
    if (originalInternalSecret === undefined) {
      delete process.env.TOOLBOX_INTERNAL_SECRET;
    } else {
      process.env.TOOLBOX_INTERNAL_SECRET = originalInternalSecret;
    }
    mock.restore();
  });

  test("registers every built-in Lobu tool", () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "telegram",
      workspaceDir: "/tmp/test-workspace",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "upload_file",
      "generate_image",
      "generate_audio",
      "get_channel_history",
      "ask_user",
      "request_human_decision",
      "start_project_context_discovery",
    ]);
  });

  test("built-in Lobu tool schemas can be projected for Gemini function declarations", () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "telegram",
      workspaceDir: "/tmp/test-workspace",
    });

    const projected = projectToolParametersForProvider(tools, "gemini");

    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      expect(node.anyOf).toBeUndefined();
      expect(node.oneOf).toBeUndefined();
      expect(node.allOf).toBeUndefined();
      expect(node.const).toBeUndefined();
      for (const child of Object.values(node)) walk(child);
    };

    for (const tool of projected) {
      walk(tool.parameters);
    }
  });

  test("detects duplicate provider tool names before model request construction", () => {
    expect(
      findDuplicateToolNames([
        { name: "notion_search" },
        { name: "trial_sessions_list" },
        { name: "notion_search" },
      ])
    ).toEqual([{ name: "notion_search", count: 2 }]);
  });

  test("registers materialized personal-agent connector tools and calls Toolbox MCP execution", async () => {
    const fetchMock = mock(async () =>
      Response.json({
        content: [{ type: "text", text: "tool executed" }],
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent",
      userId: "toolbox-user",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      toolboxPersonalAgentTools: [
        {
          connectorKey: "google_workspace",
          connectionRef: "toolbox-mcp:ref",
          tools: [
            {
              name: "google_workspace_drive_search",
              connectorToolName: "drive_search",
              description:
                "Search Google Drive files available to the connected Toolbox user.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "number" },
                },
                required: ["query"],
              },
            },
          ],
        },
        {
          connectorKey: "shifu_toolbox",
          connectionRef: "toolbox-mcp:profile",
          tools: [
            {
              name: "submit_course_pm_profile",
              connectorToolName: "submit_course_pm_profile",
              description: "Submit a course PM onboarding profile.",
              inputSchema: {
                type: "object",
                properties: {
                  payloadKind: { type: "string", const: "course_pm_profile" },
                  courses: { type: "array", items: { type: "object" } },
                },
                required: ["payloadKind", "courses"],
              },
            },
          ],
        },
      ],
    });

    const searchTool = tools.find(
      (tool) => tool.name === "google_workspace_drive_search"
    );

    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("tool-call-1", {
      query: "超級AI個體",
    });

    expect(result.content[0]?.text).toContain("tool executed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe(
      "http://gateway/worker/internal/toolbox-personal-agent-tools/call"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer worker-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      connectorKey: "google_workspace",
      connectionRef: "toolbox-mcp:ref",
      connectorToolName: "drive_search",
      args: { query: "超級AI個體" },
    });

    const profileTool = tools.find(
      (tool) => tool.name === "submit_course_pm_profile"
    );
    expect(profileTool).toBeDefined();

    await profileTool!.execute("tool-call-2", {
      payloadKind: "course_pm_profile",
      courses: [{ courseName: "超級AI個體" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, profileInit] = fetchMock.mock.calls[1] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(profileInit.body))).toEqual({
      connectorKey: "shifu_toolbox",
      connectionRef: "toolbox-mcp:profile",
      connectorToolName: "submit_course_pm_profile",
      args: {
        payloadKind: "course_pm_profile",
        courses: [{ courseName: "超級AI個體" }],
      },
    });
  });

  test("keeps Toolbox personal Notion tool and first-class MCP Notion tool globally unique for Gemini", () => {
    const gw = {
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent",
      userId: "toolbox-user",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    };

    const customTools = createOpenClawCustomTools({
      ...gw,
      toolboxPersonalAgentTools: [
        {
          connectorKey: "notion",
          connectionRef: "toolbox-mcp:ref",
          tools: [
            {
              name: "notion_search",
              connectorToolName: "notion-search",
              description:
                "Search Notion pages and databases available to the connected Toolbox user.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "number" },
                },
                required: ["query"],
              },
            },
          ],
        },
      ],
    });

    const projectedMcp = projectMcpToolsForProvider(
      {
        notion: [
          {
            name: "notion-search",
            description: "Search Notion MCP",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
      {
        provider: "gemini",
        directToolLimit: 100,
        reservedProviderToolNames: new Set(
          customTools.map((tool) => tool.name)
        ),
      }
    );

    const mcpToolDefs = createMcpToolDefinitions(projectedMcp.tools, gw);
    const names = [...customTools, ...mcpToolDefs].map((tool) => tool.name);
    expect(names.filter((name) => name === "notion_search")).toHaveLength(1);
    expect(names).toContain("notion_search_2");
    expect(new Set(names).size).toBe(names.length);
  });

  test("upload_file emits a file-uploaded custom event after a successful upload", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lobu-custom-tool-"));
    const filePath = join(tempDir, "proof.txt");
    writeFileSync(filePath, "proof");

    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/internal/files/upload")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({
        fileId: "file-123",
        name: "proof.txt",
        permalink: "https://files.example/proof.txt",
      });
    }) as unknown as typeof fetch;

    try {
      const uploadTool = createOpenClawCustomTools({
        gatewayUrl: "http://gateway",
        workerToken: "worker-token",
        agentId: "agent-1",
        channelId: "channel-1",
        conversationId: "conversation-1",
        platform: "telegram",
        workspaceDir: tempDir,
        onCustomEvent: (name, data) => {
          events.push({ name, data });
        },
      }).find((tool) => tool.name === "upload_file");

      expect(uploadTool).toBeDefined();

      const result = await uploadTool!.execute("tool-call-1", {
        file_path: filePath,
      });

      expect(result.content[0]?.text).toContain(
        "Successfully showed proof.txt to the user"
      );
      expect(events).toEqual([
        {
          name: "file-uploaded",
          data: {
            tool: "upload_file",
            platform: "telegram",
            fileId: "file-123",
            name: "proof.txt",
            permalink: "https://files.example/proof.txt",
            size: 5,
          },
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ask_user invokes onAskUserPosted after a successful post", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith("/internal/interactions/create")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({ id: "question-1" });
    }) as unknown as typeof fetch;

    let posted = 0;
    const askTool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "slack",
      workspaceDir: "/tmp/test-workspace",
      onAskUserPosted: () => posted++,
    }).find((tool) => tool.name === "ask_user");

    expect(askTool).toBeDefined();

    const result = await askTool!.execute("tool-call-1", {
      question: "Which one?",
      options: ["a", "b"],
    });

    expect(posted).toBe(1);
    expect(result.content[0]?.text).toContain("Question posted with buttons");
  });

  test("start_project_context_discovery posts the project seed to Toolbox with internal auth", async () => {
    process.env.TOOLBOX_PROJECT_DISCOVERY_URL =
      "https://toolbox.example/agent-workbench/project-context/internal/discovery-runs";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    const fetchMock = mock(async () =>
      Response.json({
        run: {
          id: "run-1",
          status: "completed",
          evidenceCount: 2,
          confirmedEvidenceCount: 1,
          memoryWriteStatus: "written",
        },
        contextPack: {
          id: "pack-1",
          title: "技術分析全攻略課程",
          confidence: "high",
        },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent-1",
      userId: "toolbox-user-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    }).find(
      (candidate) => candidate.name === "start_project_context_discovery"
    );

    expect(tool).toBeDefined();

    const result = await tool!.execute("tool-call-1", {
      projectName: "技術分析全攻略課程",
      aliases: ["技術分析全攻略"],
      projectType: "course",
      userRole: "負責課程內容與專案推進",
      timeRange: { mode: "last_90_days" },
    });

    expect(result.content[0]?.text).toContain(
      "Project context discovery started"
    );
    expect(result.content[0]?.text).toContain("技術分析全攻略課程");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe(
      "https://toolbox.example/agent-workbench/project-context/internal/discovery-runs"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "X-Internal-Secret": "internal-secret",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      ownerUserId: "toolbox-user-1",
      agentId: "shifu-u-agent-1",
      projectName: "技術分析全攻略課程",
      aliases: ["技術分析全攻略"],
      projectType: "course",
      userRole: "負責課程內容與專案推進",
      timeRange: { mode: "last_90_days" },
    });
  });

  test("start_project_context_discovery refuses to call Toolbox without current user identity", async () => {
    process.env.TOOLBOX_PROJECT_DISCOVERY_URL =
      "https://toolbox.example/agent-workbench/project-context/internal/discovery-runs";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    const fetchMock = mock(async () => Response.json({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    }).find(
      (candidate) => candidate.name === "start_project_context_discovery"
    );

    const result = await tool!.execute("tool-call-1", {
      projectName: "技術分析全攻略課程",
    });

    expect(result.content[0]?.text).toContain(
      "missing the current user or agent identity"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("start_project_context_discovery reports Toolbox errors without throwing", async () => {
    process.env.TOOLBOX_PROJECT_DISCOVERY_URL =
      "https://toolbox.example/agent-workbench/project-context/internal/discovery-runs";
    process.env.TOOLBOX_INTERNAL_SECRET = "internal-secret";
    const fetchMock = mock(async () =>
      Response.json({ error: "missing ownerUserId" }, { status: 400 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const tool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-agent-1",
      userId: "toolbox-user-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    }).find(
      (candidate) => candidate.name === "start_project_context_discovery"
    );

    const result = await tool!.execute("tool-call-1", {
      projectName: "技術分析全攻略課程",
    });

    expect(result.content[0]?.text).toContain(
      "Project context discovery failed: missing ownerUserId"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
