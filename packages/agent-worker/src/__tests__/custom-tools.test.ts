import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  createMcpToolDefinitions,
  createOpenClawCustomTools,
} from "../openclaw/custom-tools";
import {
  projectMcpToolsForProvider,
  projectToolParametersForProvider,
} from "../openclaw/mcp-tool-projection";
import { findDuplicateToolNames } from "../openclaw/session-runner";
import { deriveTurnExecutionIntent } from "../openclaw/turn-execution-intent";

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
      "artifact_read",
      "generate_image",
      "generate_audio",
      "get_channel_history",
      "ask_user",
      "request_human_decision",
      "start_project_context_discovery",
    ]);
  });

  test("request_human_decision schema strictly validates automation confirmation context", () => {
    const tool = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
    }).find((candidate) => candidate.name === "request_human_decision");
    expect(tool).toBeDefined();

    const base = {
      title: "Confirm automation",
      prompt: "Create it?",
      options: [
        {
          value: "confirm",
          label: "Confirm",
          tradeoff: "Creates it.",
          recommended: true,
          recommendationReason: "Plan is ready.",
        },
        { value: "revise", label: "Revise", tradeoff: "Takes longer." },
        { value: "cancel", label: "Cancel", tradeoff: "Stops here." },
      ],
    };
    const validContext = {
      kind: "automation_create",
      planId: "plan-1",
      planVersion: 1,
      contentHash: "sha256:abc",
    };

    expect(Value.Check(tool!.parameters, base)).toBe(true);
    expect(
      Value.Check(tool!.parameters, {
        ...base,
        confirmationContext: validContext,
      })
    ).toBe(true);
    for (const confirmationContext of [
      { ...validContext, kind: "unknown" },
      { ...validContext, planId: " " },
      { ...validContext, planVersion: "1" },
      { ...validContext, planVersion: 0 },
      { ...validContext, planVersion: 1.5 },
      { ...validContext, contentHash: " " },
      { ...validContext, kind: undefined },
      { ...validContext, planId: undefined },
      { ...validContext, planVersion: undefined },
      { ...validContext, contentHash: undefined },
      { ...validContext, extra: "not-allowed" },
    ]) {
      expect(
        Value.Check(tool!.parameters, { ...base, confirmationContext })
      ).toBe(false);
    }
  });

  test("registers always-on runtime tool catalog tools when catalog is provided", async () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      runtimeToolCatalog: [
        {
          tool: {
            name: "sales_battle_report_run_now",
            description: "立即發送課程 PM 銷售戰報",
            inputSchema: { type: "object", properties: {} },
          },
          name: "sales_battle_report_run_now",
          mcpId: "shifu-toolbox",
          domain: "battle_report",
          intent: "battle_report",
          priority: "P0",
          originalIndex: 0,
          availableThisTurn: true,
          directVisibleThisTurn: true,
          callableViaCatalog: true,
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toContain("tool_search");
    expect(tools.map((tool) => tool.name)).toContain("tool_call");
    expect(tools.map((tool) => tool.name)).toContain("tool_status");

    const searchTool = tools.find((tool) => tool.name === "tool_search");
    expect(searchTool).toBeDefined();

    const result = await searchTool!.execute("tool-call-1", {
      query: "發送戰報",
    });

    const text = result.content[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!);
    expect(parsed.matches[0]).toMatchObject({
      name: "sales_battle_report_run_now",
      mcpId: "shifu-toolbox",
      totalScore: expect.any(Number),
      reasons: expect.any(Array),
    });
    expect(JSON.stringify(parsed)).not.toContain("inputSchema");
  });

  test("tool_call catalog failures surface as failed tool results", async () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      runtimeToolCatalog: [
        {
          tool: {
            name: "card_studio_heavy_export",
            description: "Export a large course promotion card deck",
            inputSchema: { type: "object", properties: {} },
          },
          name: "card_studio_heavy_export",
          mcpId: "shifu-toolbox",
          domain: "card_studio",
          intent: "card_studio",
          priority: "P3",
          aliases: [],
          readOnly: true,
          mutatesState: false,
          requiresConfirmation: false,
          originalIndex: 0,
          availableThisTurn: false,
          directVisibleThisTurn: false,
          callableViaCatalog: false,
          callBlockedReason: "not_allowed",
          description: "Export a large course promotion card deck",
        },
      ],
      runtimeToolCaller: mock(async () => ({
        content: [{ type: "text" as const, text: "should not run" }],
      })),
    });

    const toolCall = tools.find((tool) => tool.name === "tool_call");
    expect(toolCall).toBeDefined();

    const result = await toolCall!.execute("tool-call-1", {
      tool_name: "card_studio_heavy_export",
      args: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"code": "not_allowed"');
  });

  test("tool_call applies the personal reminder execution contract", async () => {
    const calls: unknown[][] = [];
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "shifu-u-1",
      channelId: "channel-1",
      conversationId: "line-conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      turnExecutionIntent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
      runtimeToolCatalog: [
        {
          tool: {
            name: "manage_schedules",
            description: "Manage schedules",
            inputSchema: { type: "object", properties: {} },
          },
          name: "manage_schedules",
          mcpId: "lobu-memory",
          domain: "automation",
          intent: "automation",
          priority: "P1",
          aliases: [],
          readOnly: false,
          mutatesState: true,
          requiresConfirmation: false,
          originalIndex: 0,
          availableThisTurn: false,
          directVisibleThisTurn: false,
          callableViaCatalog: true,
          description: "Manage schedules",
        },
      ],
      runtimeToolCaller: mock(async (...args) => {
        calls.push(args);
        return { content: [{ type: "text" as const, text: "ok" }] };
      }),
    });

    const toolCall = tools.find((tool) => tool.name === "tool_call");
    await toolCall!.execute("tool-call-reminder", {
      tool_name: "manage_schedules",
      mcp_id: "lobu-memory",
      args: {
        action: "create",
        run_at: "2026-07-14T12:35:00.000Z",
        action_type: "send_notification",
        title: "喝水",
      },
    });

    expect(calls).toEqual([
      [
        "lobu-memory",
        "manage_schedules",
        {
          action: "create",
          run_at: "2026-07-14T12:35:00.000Z",
          action_type: "wake_agent",
          agent_id: "shifu-u-1",
          thread_id: "line-conversation-1",
          prompt: "喝水",
        },
      ],
    ]);
  });

  test("tool_status reports clarification blocks without exposing schemas or messages", async () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      runtimeToolCatalog: [
        {
          tool: {
            name: "gws_calendar_events_create",
            description: "Create a Google Calendar event",
            inputSchema: {
              type: "object",
              properties: { privateNote: { type: "string" } },
            },
          },
          name: "gws_calendar_events_create",
          mcpId: "google_workspace",
          domain: "calendar",
          intent: "calendar",
          priority: "P1",
          aliases: [],
          readOnly: false,
          mutatesState: true,
          requiresConfirmation: true,
          originalIndex: 0,
          availableThisTurn: false,
          directVisibleThisTurn: false,
          callableViaCatalog: false,
          callBlockedReason: "clarification_required",
          description: "Create a Google Calendar event",
        },
      ],
    });
    const statusTool = tools.find((tool) => tool.name === "tool_status");
    expect(statusTool).toBeDefined();

    const result = await statusTool!.execute("tool-call-1", {
      tool_name: "gws_calendar_events_create",
      mcp_id: "google_workspace",
    });
    const text = result.content[0]?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text!)).toMatchObject({
      name: "gws_calendar_events_create",
      callableViaCatalog: false,
      callBlockedReason: "clarification_required",
    });
    expect(text).not.toContain("inputSchema");
    expect(text).not.toContain("privateNote");
    expect(text).not.toContain("user message");
  });

  test("tool_call delegated MCP failures surface as failed tool results", async () => {
    const tools = createOpenClawCustomTools({
      gatewayUrl: "http://gateway",
      workerToken: "worker-token",
      agentId: "agent-1",
      channelId: "channel-1",
      conversationId: "conversation-1",
      platform: "line",
      workspaceDir: "/tmp/test-workspace",
      runtimeToolCatalog: [
        {
          tool: {
            name: "card_studio_heavy_export",
            description: "Export a large course promotion card deck",
            inputSchema: { type: "object", properties: {} },
          },
          name: "card_studio_heavy_export",
          mcpId: "shifu-toolbox",
          domain: "card_studio",
          intent: "card_studio",
          priority: "P3",
          aliases: [],
          readOnly: true,
          mutatesState: false,
          requiresConfirmation: false,
          originalIndex: 0,
          availableThisTurn: false,
          directVisibleThisTurn: false,
          callableViaCatalog: true,
          description: "Export a large course promotion card deck",
        },
      ],
      runtimeToolCaller: mock(async () => ({
        content: [
          {
            type: "text" as const,
            text: "Error: Tool call requires approval.",
          },
        ],
        isError: true,
        errorCode: "approval_required",
      })),
    });

    const toolCall = tools.find((tool) => tool.name === "tool_call");
    expect(toolCall).toBeDefined();

    const result = await toolCall!.execute("tool-call-1", {
      tool_name: "card_studio_heavy_export",
      args: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"code": "approval_required"');
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

  test("keeps direct official Notion MCP tools authoritative over Toolbox wrappers for Gemini", () => {
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
            {
              name: "notion_update_page",
              connectorToolName: "notion_update_page",
              description: "Update a Notion page.",
              inputSchema: {
                type: "object",
                properties: {
                  page_id: { type: "string" },
                  properties: { type: "object" },
                },
                required: ["page_id"],
              },
            },
            {
              name: "notion_read_page",
              connectorToolName: "notion_read_page",
              description: "Read a Notion page.",
              inputSchema: {
                type: "object",
                properties: { page_id: { type: "string" } },
                required: ["page_id"],
              },
            },
            {
              name: "notion_read_database",
              connectorToolName: "notion_read_database",
              description: "Read a Notion database.",
              inputSchema: {
                type: "object",
                properties: { database_id: { type: "string" } },
                required: ["database_id"],
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
          {
            name: "notion-update-page",
            description: "Update Notion page MCP",
            inputSchema: {
              type: "object",
              properties: { page_id: { type: "string" } },
              required: ["page_id"],
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
    expect(names.filter((name) => name === "notion_update_page")).toHaveLength(
      1
    );
    expect(names).not.toContain("notion_read_page");
    expect(names).not.toContain("notion_read_database");
    expect(names).not.toContain("notion_search_2");
    expect(names).not.toContain("notion_update_page_2");
    expect(new Set(names).size).toBe(names.length);
  });

  test("keeps non-official Toolbox Notion tools available", () => {
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
          connectorKey: "notion",
          connectionRef: "toolbox-mcp:ref",
          tools: [
            {
              name: "course_pm_notion_lookup",
              connectorToolName: "course_pm_notion_lookup",
              description: "Course PM Notion lookup helper.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toContain("course_pm_notion_lookup");
  });

  test("keeps provider suffix fallback for non-official Toolbox Notion collisions", () => {
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
              name: "course_pm_notion_lookup",
              connectorToolName: "course_pm_notion_lookup",
              description: "Course PM Notion lookup helper.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
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
            name: "course-pm-notion-lookup",
            description: "Course PM Notion lookup MCP.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
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
    expect(names).toContain("course_pm_notion_lookup");
    expect(names).toContain("course_pm_notion_lookup_2");
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
