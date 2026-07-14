import { describe, expect, mock, test } from "bun:test";
import type { McpToolDef, ReleaseCapabilityState } from "@lobu/core";
import {
  buildPersonalReminderDeliveryInstructions,
  buildEffectiveToolInventory,
  PERSONAL_REMINDER_DELIVERY_CAPABILITY,
} from "../openclaw/effective-tool-inventory";
import { createMcpToolDefinitions } from "../openclaw/custom-tools";
import { selectMcpToolsByMcpForTurn } from "../openclaw/dynamic-tool-loader";
import { buildMcpToolInventoryInstructions } from "../openclaw/session-context";
import { qualifiedToolKey } from "../openclaw/tool-descriptor";
import { deriveTurnExecutionIntent } from "../openclaw/turn-execution-intent";
import {
  buildRuntimeToolCatalog,
  dispatchRuntimeToolCall,
  searchRuntimeToolCatalog,
  statusRuntimeToolCatalog,
} from "../openclaw/tool-catalog-dispatcher";

function tool(name: string): McpToolDef {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  };
}

const MALFORMED_MCP_ID = "mcp\ud800";

function active(capabilityIds: string[]): ReleaseCapabilityState {
  return {
    status: "active",
    claim: {
      environment: "production",
      toolboxUserId: "user-1",
      agentId: "agent-1",
      releaseId: "release-7",
      releaseSequence: 7,
      snapshotDigest: "sha256:snapshot-7",
      expiresAt: "2099-01-01T00:00:00.000Z",
      capabilityIds,
    },
  };
}

describe("effective tool inventory", () => {
  test("is the immutable intersection of discovery, connection, grant, policy, release and turn constraints", () => {
    const scopedTools = {
      connected: [tool("allowed"), tool("policy_denied"), tool("approval")],
      disconnected: [tool("needs_login")],
      gated: [tool("release_only")],
    };

    const inventory = buildEffectiveToolInventory({
      scopedTools,
      releaseState: active([]),
      connectedMcpIds: ["connected", "gated"],
      grantedToolKeys: [
        "connected/allowed",
        "connected/policy_denied",
        "connected/approval",
        "disconnected/needs_login",
        "gated/release_only",
      ],
      isPolicyAllowed: (key) => key !== "connected/policy_denied",
      releaseCapabilityByToolKey: {
        "gated/release_only": "release_only.v1",
      },
      approvalRequiredToolKeys: ["connected/approval"],
    });

    expect(inventory.allowedToolKeys).toEqual(["connected/allowed"]);
    expect(Object.keys(inventory.toolsByMcp)).toEqual(["connected"]);
    expect(inventory.blocked).toEqual([
      { toolKey: "connected/approval", reason: "approval_required" },
      { toolKey: "connected/policy_denied", reason: "policy_denied" },
      { toolKey: "disconnected/needs_login", reason: "not_connected" },
      { toolKey: "gated/release_only", reason: "capability_inactive" },
    ]);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.allowedToolKeys)).toBe(true);
    expect(Object.isFrozen(inventory.blocked)).toBe(true);
    expect(Object.isFrozen(inventory.toolsByMcp.connected)).toBe(true);
    expect(inventory.scopedTools).not.toBe(scopedTools);
  });

  test("a release cannot manufacture, reconnect or grant a tool", () => {
    const inventory = buildEffectiveToolInventory({
      scopedTools: { disconnected: [tool("existing")] },
      releaseState: active(["manufactured.v1"]),
      connectedMcpIds: [],
      grantedToolKeys: [],
      releaseCapabilityByToolKey: {
        "missing/invented": "manufactured.v1",
        "disconnected/existing": "manufactured.v1",
      },
    });

    expect(inventory.allowedToolKeys).toEqual([]);
    expect(inventory.blocked).toEqual([
      { toolKey: "disconnected/existing", reason: "not_connected" },
      { toolKey: "missing/invented", reason: "not_discovered" },
    ]);
  });

  test("fingerprint is stable but release-provenance sensitive", () => {
    const input = {
      scopedTools: { mcp: [tool("one"), tool("two")] },
      connectedMcpIds: ["mcp"],
      grantedToolKeys: ["mcp/one", "mcp/two"],
    };
    const first = buildEffectiveToolInventory({
      ...input,
      releaseState: active([PERSONAL_REMINDER_DELIVERY_CAPABILITY]),
    });
    const reordered = buildEffectiveToolInventory({
      scopedTools: { mcp: [tool("two"), tool("one")] },
      connectedMcpIds: ["mcp"],
      grantedToolKeys: ["mcp/two", "mcp/one"],
      releaseState: active([PERSONAL_REMINDER_DELIVERY_CAPABILITY]),
    });
    const legacy = buildEffectiveToolInventory({
      ...input,
      releaseState: { status: "legacy_unenrolled" },
    });

    expect(first.fingerprint).toBe(reordered.fingerprint);
    expect(first.fingerprint).not.toBe(legacy.fingerprint);
    expect(first.releaseProvenance).toMatchObject({
      status: "active",
      releaseId: "release-7",
      releaseSequence: 7,
      snapshotDigest: "sha256:snapshot-7",
    });
  });

  test.each([
    [{ status: "legacy_unenrolled" }, "legacy_compatible", true, false],
    [active([PERSONAL_REMINDER_DELIVERY_CAPABILITY]), "active", true, true],
    [active([]), "capability_inactive", false, false],
    [
      {
        status: "enrolled_inactive",
        environment: "production",
        reason: "snapshot_unavailable",
      },
      "snapshot_missing",
      false,
      false,
    ],
    [
      {
        status: "enrolled_inactive",
        environment: "production",
        reason: "capability_expired",
      },
      "snapshot_expired",
      false,
      false,
    ],
  ] as const)("projects personal reminder behavior for release state %#", (releaseState, state, executable, mayPromiseDelivery) => {
    const inventory = buildEffectiveToolInventory({
      scopedTools: { "lobu-memory": [tool("manage_schedules")] },
      releaseState: releaseState as ReleaseCapabilityState,
    });

    expect(inventory.allowedToolKeys).toEqual(["lobu-memory/manage_schedules"]);
    expect(inventory.behaviors.personalReminderDelivery).toEqual({
      capabilityId: PERSONAL_REMINDER_DELIVERY_CAPABILITY,
      state,
      executable,
      mayPromiseDelivery,
    });
  });

  test("rejects an unbounded discovered inventory", () => {
    expect(() =>
      buildEffectiveToolInventory({
        scopedTools: {
          mcp: Array.from({ length: 4097 }, (_, index) =>
            tool(`tool_${index}`)
          ),
        },
        releaseState: { status: "legacy_unenrolled" },
      })
    ).toThrow("effective tool inventory exceeds 4096 discovered tools");
  });

  test.each([
    ["MCP id", { [MALFORMED_MCP_ID]: [tool("safe")] }],
    ["tool name", { mcp: [tool("name\udfff")] }],
  ])("fails a malformed production inventory %s closed", (_label, scopedTools) => {
    expect(() =>
      buildEffectiveToolInventory({
        scopedTools,
        releaseState: { status: "legacy_unenrolled" },
      })
    ).toThrow("invalid UTF-16 string: unpaired surrogate");
  });

  test("renders a delivery promise only for the active signed capability", () => {
    const common = {
      scopedTools: { "lobu-memory": [tool("manage_schedules")] },
    };
    const enrolled = buildEffectiveToolInventory({
      ...common,
      releaseState: active([PERSONAL_REMINDER_DELIVERY_CAPABILITY]),
    });
    const legacy = buildEffectiveToolInventory({
      ...common,
      releaseState: { status: "legacy_unenrolled" },
    });
    const inactive = buildEffectiveToolInventory({
      ...common,
      releaseState: active([]),
    });

    expect(buildPersonalReminderDeliveryInstructions(enrolled)).toContain(
      "will return to this personal-agent conversation"
    );
    expect(buildPersonalReminderDeliveryInstructions(legacy)).toBe("");
    expect(buildPersonalReminderDeliveryInstructions(inactive)).toBe("");
  });

  test("keeps prompt, provider, router, search, status, call and dispatcher on one denied-tool truth", async () => {
    const inventory = buildEffectiveToolInventory({
      scopedTools: {
        school: [tool("search_students")],
        secret: [tool("search_payroll")],
      },
      releaseState: { status: "legacy_unenrolled" },
      isPolicyAllowed: (key) => key !== "secret/search_payroll",
    });
    const prompt = buildMcpToolInventoryInstructions(inventory.toolsByMcp, []);
    const routing = selectMcpToolsByMcpForTurn({
      toolsByMcp: inventory.toolsByMcp,
      message: "search payroll",
      budget: 8,
      routerMode: "semantic",
    });
    const providerDefinitions = createMcpToolDefinitions(
      routing.selectedTools,
      {
        gatewayUrl: "http://gateway",
        workerToken: "token",
        agentId: "agent-1",
        channelId: "line-1",
        conversationId: "conversation-1",
        platform: "line",
      }
    );
    const catalog = buildRuntimeToolCatalog({
      allTools: inventory.scopedTools,
      selectedTools: routing.selectedTools,
      allowedToolNames: inventory.allowedToolKeys,
      blockedToolReasons: Object.fromEntries(
        inventory.blocked.map((entry) => [entry.toolKey, entry.reason])
      ),
    });

    expect(prompt).toContain("search_students");
    expect(prompt).not.toContain("search_payroll");
    expect(
      routing.trace.candidates.map((candidate) => candidate.name)
    ).not.toContain("search_payroll");
    expect(
      providerDefinitions.map((definition) => definition.name)
    ).not.toContain("search_payroll");
    expect(searchRuntimeToolCatalog(catalog, { query: "payroll" })).toEqual([]);
    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "secret",
        toolName: "search_payroll",
      })
    ).toMatchObject({
      callableViaCatalog: false,
      callBlockedReason: "policy_denied",
    });
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "must not run" }],
    }));
    const result = await dispatchRuntimeToolCall({
      catalog,
      allowedToolKeys: inventory.allowedToolKeys,
      mcpId: "secret",
      // Simulates a stale tool name recovered from transcript memory.
      toolName: "search_payroll",
      args: {},
      callTool,
    });
    expect(result).toMatchObject({ ok: false, code: "policy_denied" });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("fails a duplicate identity closed once across every consumer and fingerprints both schemas", async () => {
    const duplicate = (schemaLabel: string): McpToolDef => ({
      name: "duplicate",
      description: `duplicate ${schemaLabel}`,
      inputSchema: {
        type: "object",
        properties: { value: { type: schemaLabel } },
      },
    });
    const build = (first: string, second: string) =>
      buildEffectiveToolInventory({
        scopedTools: { source: [duplicate(first), duplicate(second)] },
        releaseState: { status: "legacy_unenrolled" },
      });
    const inventory = build("string", "number");
    const reversed = build("number", "string");
    const firstChanged = build("boolean", "number");

    expect(inventory.blocked).toEqual([
      { toolKey: "source/duplicate", reason: "duplicate_identity" },
    ]);
    expect(inventory.allowedToolKeys).toEqual([]);
    expect(inventory.scopedTools.source).toHaveLength(1);
    expect(inventory.fingerprint).toBe(reversed.fingerprint);
    expect(inventory.fingerprint).not.toBe(firstChanged.fingerprint);
    expect(buildMcpToolInventoryInstructions(inventory.toolsByMcp, [])).toBe(
      ""
    );
    const routing = selectMcpToolsByMcpForTurn({
      toolsByMcp: inventory.toolsByMcp,
      message: "use duplicate",
      budget: 8,
      routerMode: "semantic",
    });
    expect(routing.trace.candidates).toEqual([]);
    expect(
      createMcpToolDefinitions(routing.selectedTools, {
        gatewayUrl: "http://gateway",
        workerToken: "token",
        agentId: "agent-1",
        channelId: "line-1",
        conversationId: "conversation-1",
        platform: "line",
      })
    ).toEqual([]);
    const catalog = buildRuntimeToolCatalog({
      allTools: inventory.scopedTools,
      selectedTools: {},
      allowedToolNames: inventory.allowedToolKeys,
      blockedToolReasons: { "source/duplicate": "duplicate_identity" },
    });
    expect(searchRuntimeToolCatalog(catalog, { query: "duplicate" })).toEqual(
      []
    );
    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "source",
        toolName: "duplicate",
      })
    ).toMatchObject({ callBlockedReason: "duplicate_identity" });
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "must not run" }],
    }));
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        mcpId: "source",
        toolName: "duplicate",
        args: {},
        callTool,
      })
    ).resolves.toMatchObject({ ok: false, code: "duplicate_identity" });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("keeps slash-containing identities independently eligible across router and dispatcher", async () => {
    const allowedKey = qualifiedToolKey("a/b", "c");
    const blockedKey = qualifiedToolKey("a", "b/c");
    const inventory = buildEffectiveToolInventory({
      scopedTools: {
        "a/b": [tool("c")],
        a: [tool("b/c")],
      },
      releaseState: { status: "legacy_unenrolled" },
      grantedToolKeys: [allowedKey, blockedKey],
      approvalRequiredToolKeys: [blockedKey],
    });

    expect(allowedKey).toBe("a%2Fb/c");
    expect(blockedKey).toBe("a/b%2Fc");
    expect(inventory.allowedToolKeys).toEqual([allowedKey]);
    expect(inventory.blocked).toEqual([
      { toolKey: blockedKey, reason: "approval_required" },
    ]);
    const releaseGated = buildEffectiveToolInventory({
      scopedTools: inventory.scopedTools,
      releaseState: active([]),
      grantedToolKeys: [allowedKey, blockedKey],
      releaseCapabilityByToolKey: { [blockedKey]: "slash-tool.v1" },
    });
    expect(releaseGated.allowedToolKeys).toEqual([allowedKey]);
    expect(releaseGated.blocked).toContainEqual({
      toolKey: blockedKey,
      reason: "capability_inactive",
    });
    const route = selectMcpToolsByMcpForTurn({
      toolsByMcp: inventory.scopedTools,
      message: "use c",
      budget: 8,
      routerMode: "semantic",
      allowedToolNames: inventory.allowedToolKeys,
    });
    expect(route.trace.candidates.map((entry) => entry.key)).not.toContain(
      blockedKey
    );
    const catalog = buildRuntimeToolCatalog({
      allTools: inventory.scopedTools,
      selectedTools: route.selectedTools,
      allowedToolNames: inventory.allowedToolKeys,
      blockedToolReasons: Object.fromEntries(
        inventory.blocked.map((entry) => [entry.toolKey, entry.reason])
      ),
    });
    expect(
      statusRuntimeToolCatalog(catalog, { mcpId: "a/b", toolName: "c" })
    ).toMatchObject({ callableViaCatalog: true });
    expect(
      statusRuntimeToolCatalog(catalog, { mcpId: "a", toolName: "b/c" })
    ).toMatchObject({
      callableViaCatalog: false,
      callBlockedReason: "approval_required",
    });
    const callTool = mock(async () => ({ content: [] }));
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        mcpId: "a/b",
        toolName: "c",
        args: {},
        callTool,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        mcpId: "a",
        toolName: "b/c",
        args: {},
        callTool,
      })
    ).resolves.toMatchObject({ ok: false, code: "approval_required" });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  test("blocks only the personal-reminder behavior while ordinary manage_schedules remains callable", async () => {
    const inventory = buildEffectiveToolInventory({
      scopedTools: {
        "lobu-memory": [tool("manage_schedules")],
      },
      releaseState: active([]),
    });
    const reason = inventory.behaviors.personalReminderDelivery.state;
    expect(reason).toBe("capability_inactive");

    const reminderRoute = selectMcpToolsByMcpForTurn({
      toolsByMcp: inventory.toolsByMcp,
      message: "五分鐘後提醒我喝水",
      budget: 8,
      routerMode: "semantic",
      personalReminderDeliveryBlockedReason: reason,
    });
    const listRoute = selectMcpToolsByMcpForTurn({
      toolsByMcp: inventory.toolsByMcp,
      message: "列出我的排程",
      budget: 8,
      routerMode: "semantic",
      personalReminderDeliveryBlockedReason: reason,
    });
    expect(
      reminderRoute.trace.candidates.map((entry) => entry.name)
    ).not.toContain("manage_schedules");
    expect(reminderRoute.trace.selectedToolNames).not.toContain(
      "lobu-memory/manage_schedules"
    );
    expect(listRoute.trace.selectedToolNames).toContain(
      "lobu-memory/manage_schedules"
    );

    const catalog = buildRuntimeToolCatalog({
      allTools: inventory.scopedTools,
      selectedTools: listRoute.selectedTools,
      allowedToolNames: inventory.allowedToolKeys,
      behaviorBlockedToolReasons: {
        "lobu-memory/manage_schedules": {
          personal_reminder: reason,
        },
      },
    });
    expect(
      searchRuntimeToolCatalog(catalog, { query: "提醒我" })[0]?.entry
    ).toMatchObject({
      name: "manage_schedules",
      behaviorBlockedReasons: { personal_reminder: "capability_inactive" },
    });
    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        executionDestination: "personal_reminder",
      })
    ).toMatchObject({
      callableViaCatalog: true,
      behaviorBlockedReasons: {
        personal_reminder: "capability_inactive",
      },
    });
    expect(
      statusRuntimeToolCatalog(catalog, {
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
      })
    ).toMatchObject({ callableViaCatalog: true });
    const callTool = mock(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        turnExecutionIntent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "create" },
        callTool,
      })
    ).resolves.toMatchObject({ ok: false, code: "capability_inactive" });
    expect(callTool).not.toHaveBeenCalled();
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        turnExecutionIntent: deriveTurnExecutionIntent("五分鐘後提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "list" },
        callTool,
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      dispatchRuntimeToolCall({
        catalog,
        allowedToolKeys: inventory.allowedToolKeys,
        turnExecutionIntent: deriveTurnExecutionIntent("取消明天提醒我喝水"),
        mcpId: "lobu-memory",
        toolName: "manage_schedules",
        args: { action: "cancel" },
        callTool,
      })
    ).resolves.toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
