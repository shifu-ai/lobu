import { SHIFU_TOOLBOX_MCP_ID } from "../../../core/src/constants";

const SCHEDULED_JOB_SOURCE = "scheduled-job";
const SCHEDULED_AUTOMATION_OPEN = "[scheduled_automation]";
const SCHEDULED_AUTOMATION_CLOSE = "[/scheduled_automation]";

const SCHEDULED_AUTOMATION_SUPPRESSED_TOOL_NAMES = new Set([
  "plan_automation",
  "create_automation",
]);

const SCHEDULED_AUTOMATION_DENIED_SCHEDULE_ACTIONS = new Set([
  "create",
  "activate",
  "update",
  "upsert",
  "set",
  "enable",
  "resume",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function platformMetadataSource(platformMetadata: unknown): string | undefined {
  const metadata = record(platformMetadata);
  const source = metadata?.source;
  return typeof source === "string" ? source : undefined;
}

export function hasScheduledAutomationBlock(userPrompt: string): boolean {
  const openIndex = userPrompt.indexOf(SCHEDULED_AUTOMATION_OPEN);
  if (openIndex < 0) return false;
  const closeIndex = userPrompt.indexOf(
    SCHEDULED_AUTOMATION_CLOSE,
    openIndex + SCHEDULED_AUTOMATION_OPEN.length
  );
  if (closeIndex < 0) return false;
  return (
    userPrompt
      .slice(openIndex + SCHEDULED_AUTOMATION_OPEN.length, closeIndex)
      .trim().length > 0
  );
}

export function isScheduledAutomationTurn(params: {
  platformMetadata: unknown;
  userPrompt: string;
}): boolean {
  return (
    platformMetadataSource(params.platformMetadata) === SCHEDULED_JOB_SOURCE &&
    hasScheduledAutomationBlock(params.userPrompt)
  );
}

export function isScheduledAutomationToolAllowed(params: {
  scheduledAutomation: boolean;
  mcpId: string;
  toolName: string;
}): boolean {
  return (
    !params.scheduledAutomation ||
    params.mcpId !== SHIFU_TOOLBOX_MCP_ID ||
    !SCHEDULED_AUTOMATION_SUPPRESSED_TOOL_NAMES.has(params.toolName)
  );
}

export function isScheduledAutomationScheduleWriteDenied(params: {
  scheduledAutomation: boolean;
  mcpId: string;
  toolName: string;
  args: Record<string, unknown>;
}): boolean {
  return (
    params.scheduledAutomation &&
    params.mcpId === "lobu-memory" &&
    params.toolName === "manage_schedules" &&
    typeof params.args.action === "string" &&
    SCHEDULED_AUTOMATION_DENIED_SCHEDULE_ACTIONS.has(params.args.action)
  );
}
