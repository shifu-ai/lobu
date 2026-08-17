export const HEARTBEAT_AUTOMATION_ID_MAX = 256;

export type HeartbeatAutomationDeliveryPolicy = "line_self" | "chat_only";

export interface TrustedHeartbeatAutomationV1 {
	automationId: string;
	taskContractId: string;
	taskContractVersion: number;
	ownerUserId: string;
	deliveryPolicy: HeartbeatAutomationDeliveryPolicy;
}

export interface ScheduledHeartbeatAutomationV1
	extends TrustedHeartbeatAutomationV1 {
	scheduleTick: string;
}

export function readTrustedHeartbeatAutomation(
	value: unknown,
): TrustedHeartbeatAutomationV1 | null {
	if (!isRecord(value)) return null;
	if (
		!bounded(value.automationId, HEARTBEAT_AUTOMATION_ID_MAX) ||
		!bounded(value.taskContractId, HEARTBEAT_AUTOMATION_ID_MAX) ||
		!Number.isInteger(value.taskContractVersion) ||
		Number(value.taskContractVersion) < 1 ||
		!bounded(value.ownerUserId, HEARTBEAT_AUTOMATION_ID_MAX) ||
		!isDeliveryPolicy(value.deliveryPolicy)
	) {
		return null;
	}
	return {
		automationId: value.automationId.trim(),
		taskContractId: value.taskContractId.trim(),
		taskContractVersion: Number(value.taskContractVersion),
		ownerUserId: value.ownerUserId.trim(),
		deliveryPolicy: value.deliveryPolicy,
	};
}

export function resolveScheduledHeartbeatAutomation(input: {
	raw: unknown;
	scheduledTick: string | undefined;
}): ScheduledHeartbeatAutomationV1 | null {
	const trusted = readTrustedHeartbeatAutomation(input.raw);
	if (!trusted || !isIsoTimestamp(input.scheduledTick)) return null;
	return { ...trusted, scheduleTick: input.scheduledTick };
}

export function renderScheduledHeartbeatAutomationBlock(
	automation: ScheduledHeartbeatAutomationV1,
): string {
	return [
		"[scheduled_automation]",
		`automation_id=${automation.automationId}`,
		`task_contract_id=${automation.taskContractId}`,
		`task_contract_version=${automation.taskContractVersion}`,
		`delivery_policy=${automation.deliveryPolicy}`,
		`schedule_tick=${automation.scheduleTick}`,
		"[/scheduled_automation]",
		"Call the ShiFu Toolbox MCP tool run_heartbeat_automation with the task_contract_id, automation_id, and schedule_tick above before writing a user-facing reply.",
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= max &&
		!/[=\r\n[\]\u0000-\u001f\u007f-\u009f]/u.test(value)
	);
}

function isDeliveryPolicy(
	value: unknown,
): value is HeartbeatAutomationDeliveryPolicy {
	return value === "line_self" || value === "chat_only";
}

function isIsoTimestamp(value: unknown): value is string {
	if (!bounded(value, HEARTBEAT_AUTOMATION_ID_MAX)) return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}
