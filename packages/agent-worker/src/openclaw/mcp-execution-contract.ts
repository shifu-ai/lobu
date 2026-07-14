import type { ToolContentResult } from "../shared/tool-implementations";
import type { TurnExecutionIntent } from "./turn-execution-intent";

export const PERSONAL_REMINDER_DELIVERY_CONTRACT =
  "personal_reminder_delivery.v1";

export interface McpExecutionTransport {
  personalReminderDelivery?: true;
}

export type McpExecutionCaller = (
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
  transport?: McpExecutionTransport
) => Promise<ToolContentResult>;

export interface McpExecutionTrace {
  requestedActionType?: "send_notification" | "wake_agent" | "other";
  effectiveActionType?: "wake_agent";
  canonicalized: boolean;
}

interface TurnGatewayProvenance {
  agentId: string;
  conversationId: string;
}

export interface ExecuteMcpToolForTurnParams {
  intent: TurnExecutionIntent;
  gateway: TurnGatewayProvenance;
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
  callTool: McpExecutionCaller;
  /** Release-aware behavior projection. Legacy callers default to Phase-1 compatibility. */
  personalReminderDeliveryExecutable?: boolean;
  onTrace?: (trace: McpExecutionTrace) => void;
}

const NOTIFICATION_ONLY_FIELDS = [
  "title",
  "body",
  "recipients",
  "resource_url",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestedActionType(
  args: Record<string, unknown>
): string | undefined {
  const payload = record(args.payload);
  const value = payload?.type ?? payload?.action_type ?? args.action_type;
  return typeof value === "string" ? value : undefined;
}

function requestedActionTypeBucket(
  requested: string | undefined
): McpExecutionTrace["requestedActionType"] {
  if (requested === undefined) return undefined;
  if (requested === "send_notification" || requested === "wake_agent") {
    return requested;
  }
  return "other";
}

function isScheduleCreateAttempt(params: ExecuteMcpToolForTurnParams): boolean {
  return (
    params.mcpId === "lobu-memory" &&
    params.toolName === "manage_schedules" &&
    params.args.action === "create"
  );
}

function reminderContent(args: Record<string, unknown>): string | undefined {
  const payload = record(args.payload);
  const values = [
    payload?.prompt,
    args.prompt,
    payload?.title,
    args.title,
    payload?.body,
    args.body,
  ];
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) unique.add(trimmed);
  }
  return unique.size > 0 ? [...unique].join("\n\n") : undefined;
}

function shouldCanonicalize(
  params: ExecuteMcpToolForTurnParams,
  requested: string | undefined
): boolean {
  return (
    params.personalReminderDeliveryExecutable !== false &&
    params.intent.destination === "personal_reminder" &&
    params.intent.confidence === "explicit" &&
    !params.intent.requiresClarification &&
    params.mcpId === "lobu-memory" &&
    params.toolName === "manage_schedules" &&
    params.args.action === "create" &&
    requested === "send_notification"
  );
}

function isExplicitPersonalReminderAttempt(
  params: ExecuteMcpToolForTurnParams
): boolean {
  return (
    params.intent.destination === "personal_reminder" &&
    params.intent.confidence === "explicit" &&
    !params.intent.requiresClarification &&
    isScheduleCreateAttempt(params)
  );
}

function canonicalPersonalReminderArgs(
  args: Record<string, unknown>,
  gateway: TurnGatewayProvenance
): Record<string, unknown> {
  const next = { ...args };
  const prompt = reminderContent(next);

  delete next.payload;
  for (const field of NOTIFICATION_ONLY_FIELDS) delete next[field];
  next.action_type = "wake_agent";
  next.agent_id = gateway.agentId;
  next.thread_id = gateway.conversationId;
  if (prompt !== undefined) next.prompt = prompt;
  else delete next.prompt;
  next.delivery_intent = {
    contract: PERSONAL_REMINDER_DELIVERY_CONTRACT,
    destination: "personal_reminder",
  };
  return next;
}

function stripDeliveryIntent(
  args: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...args };
  delete next.delivery_intent;
  const payload = record(next.payload);
  if (payload) {
    next.payload = { ...payload };
    delete (next.payload as Record<string, unknown>).delivery_intent;
  }
  return next;
}

export async function executeMcpToolForTurn(
  params: ExecuteMcpToolForTurnParams
): Promise<ToolContentResult> {
  const requested = requestedActionType(params.args);
  if (
    params.personalReminderDeliveryExecutable === false &&
    isExplicitPersonalReminderAttempt(params)
  ) {
    params.onTrace?.({
      ...(requested
        ? { requestedActionType: requestedActionTypeBucket(requested) }
        : {}),
      canonicalized: false,
    });
    return {
      isError: true,
      errorCode: "capability_inactive",
      content: [
        {
          type: "text",
          text: "personal_reminder_release_inactive",
        },
      ],
    };
  }
  const canonicalized = shouldCanonicalize(params, requested);
  const isManageSchedules =
    params.mcpId === "lobu-memory" && params.toolName === "manage_schedules";
  const sanitizedArgs = isManageSchedules
    ? stripDeliveryIntent(params.args)
    : params.args;
  const effectiveArgs = canonicalized
    ? canonicalPersonalReminderArgs(sanitizedArgs, params.gateway)
    : sanitizedArgs;
  if (isScheduleCreateAttempt(params)) {
    const requestedBucket = requestedActionTypeBucket(requested);
    params.onTrace?.({
      ...(requestedBucket ? { requestedActionType: requestedBucket } : {}),
      ...(canonicalized ? { effectiveActionType: "wake_agent" } : {}),
      canonicalized,
    });
  }
  return params.callTool(
    params.mcpId,
    params.toolName,
    effectiveArgs,
    canonicalized ? { personalReminderDelivery: true } : undefined
  );
}
