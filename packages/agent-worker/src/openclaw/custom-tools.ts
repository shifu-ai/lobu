import { getCustomToolDescription, type McpToolDef } from "@lobu/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { type TSchema, Type } from "@sinclair/typebox";
import type { GatewayParams, TextResult } from "../shared/tool-implementations";
import {
  askUserQuestion,
  callMcpTool,
  callToolboxPersonalAgentTool,
  checkMcpLogin,
  generateAudio,
  generateImage,
  getChannelHistory,
  logoutMcp,
  requestHumanDecision,
  startMcpLogin,
  startProjectContextDiscovery,
  uploadUserFile,
} from "../shared/tool-implementations";
import {
  buildMcpAuthToolNames,
  type McpAuthToolNames,
  type ProjectedMcpToolDef,
} from "./mcp-tool-projection";
import type { ToolboxPersonalAgentToolGroup } from "./session-context";

type ToolResult = AgentToolResult<Record<string, unknown>>;

/** Adapt shared TextResult to OpenClaw's ToolResult (adds details field) */
function toToolResult(result: TextResult): ToolResult {
  return { content: result.content, details: {} };
}

/**
 * Create a ToolDefinition with proper type bridging between TypeBox schemas
 * and the shared tool implementation functions. Eliminates per-tool `as` casts
 * by casting once at the boundary.
 */
function defineTool<T extends TSchema>(config: {
  name: string;
  description: string;
  parameters: T;
  run: (args: Static<T>) => Promise<TextResult>;
}): ToolDefinition {
  return {
    name: config.name,
    label: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: async (_toolCallId, args) =>
      toToolResult(await config.run(args as Static<T>)),
  };
}

export function createOpenClawCustomTools(params: {
  gatewayUrl: string;
  workerToken: string;
  agentId: string;
  userId?: string;
  channelId: string;
  conversationId: string;
  platform?: string;
  /** Session workspace directory. Required — upload_file resolves relative paths against it. */
  workspaceDir: string;
  onCustomEvent?: (
    name: string,
    data: Record<string, unknown>
  ) => Promise<void> | void;
  /**
   * Invoked after ask_user successfully posts its question. The worker
   * wires this to force the agent turn to end immediately so a weak model can't
   * re-post the same question in a loop. Optional so non-worker callers (tests)
   * can omit it.
   */
  onAskUserPosted?: () => void;
  toolboxPersonalAgentTools?: ToolboxPersonalAgentToolGroup[];
}): ToolDefinition[] {
  const gw: GatewayParams = {
    gatewayUrl: params.gatewayUrl,
    workerToken: params.workerToken,
    agentId: params.agentId,
    userId: params.userId,
    channelId: params.channelId,
    conversationId: params.conversationId,
    platform: params.platform || "slack",
    workspaceDir: params.workspaceDir,
  };

  const tools: ToolDefinition[] = [
    defineTool({
      name: "upload_file",
      description: getCustomToolDescription("upload_file"),
      parameters: Type.Object({
        file_path: Type.String({
          description:
            "Path to the file to show (absolute or relative to workspace)",
        }),
        description: Type.Optional(
          Type.String({
            description:
              "Optional description of what the file contains or shows",
          })
        ),
      }),
      run: (args) =>
        uploadUserFile(gw, args, {
          onUploaded: (data) => params.onCustomEvent?.("file-uploaded", data),
        }),
    }),

    defineTool({
      name: "generate_image",
      description: getCustomToolDescription("generate_image"),
      parameters: Type.Object({
        prompt: Type.String({
          description: "The image prompt to generate",
        }),
        size: Type.Optional(
          Type.Union(
            [
              Type.Literal("1024x1024"),
              Type.Literal("1024x1536"),
              Type.Literal("1536x1024"),
              Type.Literal("auto"),
            ],
            {
              description: "Output image size (default: 1024x1024)",
            }
          )
        ),
        quality: Type.Optional(
          Type.Union(
            [
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("auto"),
            ],
            {
              description: "Image quality (default: auto)",
            }
          )
        ),
        background: Type.Optional(
          Type.Union(
            [
              Type.Literal("transparent"),
              Type.Literal("opaque"),
              Type.Literal("auto"),
            ],
            {
              description: "Background style (default: auto)",
            }
          )
        ),
        format: Type.Optional(
          Type.Union(
            [Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")],
            {
              description: "Output image format (default: png)",
            }
          )
        ),
      }),
      run: (args) => generateImage(gw, args),
    }),

    defineTool({
      name: "generate_audio",
      description: getCustomToolDescription("generate_audio"),
      parameters: Type.Object({
        text: Type.String({
          description: "The text to convert to speech (max 4096 characters)",
        }),
        voice: Type.Optional(
          Type.String({
            description:
              "Voice ID (provider-specific). OpenAI: alloy, echo, fable, onyx, nova, shimmer. Leave empty for default.",
          })
        ),
        speed: Type.Optional(
          Type.Number({
            description: "Speech speed (0.5-2.0, default 1.0).",
          })
        ),
      }),
      run: (args) => generateAudio(gw, args),
    }),

    defineTool({
      name: "get_channel_history",
      description: getCustomToolDescription("get_channel_history"),
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Number({
            description: "Number of messages to fetch (default 50, max 100)",
          })
        ),
        before: Type.Optional(
          Type.String({
            description:
              "ISO timestamp cursor - fetch messages before this time (for pagination)",
          })
        ),
      }),
      run: (args) => getChannelHistory(gw, args),
    }),

    defineTool({
      name: "ask_user",
      description: getCustomToolDescription("ask_user"),
      parameters: Type.Object({
        question: Type.String({
          description: "The question to ask the user",
        }),
        options: Type.Array(Type.String(), {
          description: "Array of button labels for the user to choose from",
        }),
      }),
      run: (args) =>
        askUserQuestion(gw, args, { onPosted: params.onAskUserPosted }),
    }),

    defineTool({
      name: "request_human_decision",
      description: getCustomToolDescription("request_human_decision"),
      parameters: Type.Object({
        title: Type.String({
          description: "Short title for the decision request",
        }),
        prompt: Type.String({
          description:
            "Clear explanation of the recoverable blocker and the decision needed",
        }),
        options: Type.Array(
          Type.Object({
            value: Type.String({
              description: "Stable machine-readable option value",
            }),
            label: Type.String({
              description: "Short user-facing option label",
            }),
            tradeoff: Type.String({
              description: "Tradeoff or consequence of choosing this option",
            }),
            recommended: Type.Optional(
              Type.Boolean({
                description: "True for exactly one recommended option",
              })
            ),
            recommendationReason: Type.Optional(
              Type.String({
                description:
                  "Required on the recommended option; explains why it is recommended",
              })
            ),
          }),
          {
            description:
              "Exactly three recovery options. Exactly one must be recommended.",
          }
        ),
      }),
      run: (args) =>
        requestHumanDecision(gw, args, {
          onPosted: params.onAskUserPosted,
        }),
    }),

    defineTool({
      name: "start_project_context_discovery",
      description: getCustomToolDescription("start_project_context_discovery"),
      parameters: Type.Object({
        projectName: Type.String({
          description:
            "The confirmed project, product, campaign, or course name to search for.",
        }),
        aliases: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Alternate names, abbreviations, or likely file/page titles for this project.",
          })
        ),
        projectType: Type.Optional(
          Type.Union([
            Type.Literal("course"),
            Type.Literal("product"),
            Type.Literal("campaign"),
            Type.Literal("internal_project"),
            Type.Literal("unknown"),
          ])
        ),
        userRole: Type.Optional(
          Type.String({
            description:
              "The user's role or responsibility for this project, if known.",
          })
        ),
        timeRange: Type.Optional(
          Type.Object({
            mode: Type.Optional(
              Type.Union([Type.Literal("last_90_days"), Type.Literal("custom")])
            ),
            start: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            end: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          })
        ),
      }),
      run: (args) => startProjectContextDiscovery(gw, args),
    }),
  ];

  for (const group of params.toolboxPersonalAgentTools || []) {
    for (const tool of group.tools) {
      if (!tool.name?.trim()) continue;
      tools.push({
        name: tool.name,
        label: tool.name,
        description:
          tool.description || `Toolbox tool from ${group.connectorKey}`,
        parameters: tool.inputSchema
          ? Type.Unsafe(tool.inputSchema)
          : Type.Object({}),
        execute: async (_toolCallId, args) =>
          toToolResult(
            await callToolboxPersonalAgentTool(gw, {
              connectorKey: group.connectorKey,
              connectionRef: group.connectionRef,
              connectorToolName: tool.connectorToolName,
              toolArgs: (args || {}) as Record<string, unknown>,
            })
          ),
      });
    }
  }

  return tools;
}

/**
 * Convert MCP tool definitions from session context into first-class
 * OpenClaw ToolDefinition objects that call the MCP proxy directly.
 * Tools are dynamically discovered from each MCP server (e.g. lobu).
 */
export function createMcpToolDefinitions(
  mcpTools: Record<string, McpToolDef[]>,
  gw: GatewayParams,
  mcpContext?: Record<string, string>
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const registeredNames = new Set<string>();

  const toToolDefinition = (
    mcpId: string,
    def: McpToolDef,
    toolName: string,
    upstreamToolName: string,
    contextPrefix?: string
  ): ToolDefinition => {
    const schema = def.inputSchema
      ? Type.Unsafe(def.inputSchema)
      : Type.Object({});

    const baseDescription = def.description || `MCP tool from ${mcpId}`;
    const description = contextPrefix
      ? `[${contextPrefix}] ${baseDescription}`
      : baseDescription;

    return {
      name: toolName,
      label: `${mcpId}/${upstreamToolName}`,
      description:
        toolName === upstreamToolName
          ? description
          : `${description} Alias for \`${upstreamToolName}\`.`,
      parameters: schema,
      execute: async (_toolCallId, args) =>
        toToolResult(
          await callMcpTool(
            gw,
            mcpId,
            upstreamToolName,
            (args || {}) as Record<string, unknown>
          )
        ),
    };
  };

  const toSafeAlias = (name: string): string =>
    name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");

  const getProjectedSafeOnlyTool = (
    def: McpToolDef
  ):
    | {
        providerToolName: string;
        upstreamToolName: string;
      }
    | null => {
    const projected = def as ProjectedMcpToolDef;
    if (projected.providerSafeNameOnly !== true) {
      return null;
    }
    const providerToolName =
      typeof projected.providerToolName === "string"
        ? projected.providerToolName.trim()
        : "";
    const upstreamToolName =
      typeof projected.upstreamToolName === "string"
        ? projected.upstreamToolName.trim()
        : "";
    if (!providerToolName || !upstreamToolName) {
      return null;
    }
    return { providerToolName, upstreamToolName };
  };

  for (const [mcpId, defs] of Object.entries(mcpTools)) {
    const contextPrefix = mcpContext?.[mcpId];
    for (const def of defs) {
      if (!def.name || typeof def.name !== "string" || !def.name.trim()) {
        continue;
      }
      const upstreamToolName = def.name.trim();
      const projectedSafeOnly = getProjectedSafeOnlyTool(def);

      if (projectedSafeOnly) {
        if (!registeredNames.has(projectedSafeOnly.providerToolName)) {
          tools.push(
            toToolDefinition(
              mcpId,
              def,
              projectedSafeOnly.providerToolName,
              projectedSafeOnly.upstreamToolName,
              contextPrefix
            )
          );
          registeredNames.add(projectedSafeOnly.providerToolName);
        }
        continue;
      }

      if (!registeredNames.has(upstreamToolName)) {
        tools.push(
          toToolDefinition(
            mcpId,
            def,
            upstreamToolName,
            upstreamToolName,
            contextPrefix
          )
        );
        registeredNames.add(upstreamToolName);
      }

      const alias = toSafeAlias(upstreamToolName);
      if (alias !== upstreamToolName && !registeredNames.has(alias)) {
        tools.push(
          toToolDefinition(mcpId, def, alias, upstreamToolName, contextPrefix)
        );
        registeredNames.add(alias);
      }
    }
  }

  return tools;
}

export function createMcpAuthToolDefinitions(
  mcpStatus: Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput?: boolean;
    authenticated?: boolean;
    configured?: boolean;
  }>,
  gw: GatewayParams,
  existingToolNames: Set<string> = new Set(),
  options: {
    providerSafeNames?: boolean;
    authToolNames?: Record<string, McpAuthToolNames>;
  } = {}
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  for (const mcp of mcpStatus) {
    if (!mcp.requiresAuth) {
      continue;
    }

    const authToolNames =
      options.authToolNames?.[mcp.id] ??
      buildMcpAuthToolNames(mcp.id, {
        providerSafeNames: options.providerSafeNames,
        reservedNames: new Set(existingToolNames),
      });

    const loginToolName = authToolNames.login;
    if (!existingToolNames.has(loginToolName)) {
      tools.push(
        defineTool({
          name: loginToolName,
          description: `Start the authentication flow for the ${mcp.name} MCP. Use this when ${mcp.name} requires login before its tools can be used.`,
          parameters: Type.Object({}),
          run: () => startMcpLogin(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(loginToolName);
    }

    const checkToolName = authToolNames.loginCheck;
    if (!existingToolNames.has(checkToolName)) {
      tools.push(
        defineTool({
          name: checkToolName,
          description: `Check whether authentication for the ${mcp.name} MCP has completed. Call this after the user finishes login.`,
          parameters: Type.Object({}),
          run: () => checkMcpLogin(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(checkToolName);
    }

    const logoutToolName = authToolNames.logout;
    if (!existingToolNames.has(logoutToolName)) {
      tools.push(
        defineTool({
          name: logoutToolName,
          description: `Remove the stored authentication credential for the ${mcp.name} MCP.`,
          parameters: Type.Object({}),
          run: () => logoutMcp(gw, { mcpId: mcp.id }),
        })
      );
      existingToolNames.add(logoutToolName);
    }
  }

  return tools;
}
