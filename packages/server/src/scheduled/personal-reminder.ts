export const PERSONAL_REMINDER_CONTRACT_VERSION =
	"personal_reminder_delivery.v1" as const;

export interface TrustedPersonalReminderV1 {
	schemaVersion: 1;
	contractVersion: typeof PERSONAL_REMINDER_CONTRACT_VERSION;
	source: "personal_scheduled_reminder";
	toolboxUserId: string;
	lobuAgentId: string;
	conversationId: string;
	reminderContent: string;
}

export interface ScheduledPersonalReminderV1 extends TrustedPersonalReminderV1 {
	jobId: string;
	runId: number;
}

export function buildTrustedPersonalReminder(input: {
	toolboxUserId: unknown;
	lobuAgentId: unknown;
	conversationId: unknown;
	reminderContent: unknown;
}): TrustedPersonalReminderV1 | null {
	if (
		!bounded(input.toolboxUserId, 256) ||
		!bounded(input.lobuAgentId, 256) ||
		!bounded(input.conversationId, 512) ||
		!bounded(input.reminderContent, 4_000)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		contractVersion: PERSONAL_REMINDER_CONTRACT_VERSION,
		source: "personal_scheduled_reminder",
		toolboxUserId: input.toolboxUserId.trim(),
		lobuAgentId: input.lobuAgentId.trim(),
		conversationId: input.conversationId.trim(),
		reminderContent: input.reminderContent.trim(),
	};
}

export function readTrustedPersonalReminder(
	value: unknown,
): TrustedPersonalReminderV1 | null {
	if (!isRecord(value) || "lineUserId" in value) return null;
	if (
		value.schemaVersion !== 1 ||
		value.contractVersion !== PERSONAL_REMINDER_CONTRACT_VERSION ||
		value.source !== "personal_scheduled_reminder"
	) {
		return null;
	}
	return buildTrustedPersonalReminder({
		toolboxUserId: value.toolboxUserId,
		lobuAgentId: value.lobuAgentId,
		conversationId: value.conversationId,
		reminderContent: value.reminderContent,
	});
}

export function resolveScheduledPersonalReminder(input: {
	raw: unknown;
	createdByUser: string | null | undefined;
	createdByAgent: string | null | undefined;
	resolvedAgentId: string;
	jobId: string | undefined;
	runId: number | undefined;
}): ScheduledPersonalReminderV1 | null {
	const trusted = readTrustedPersonalReminder(input.raw);
	if (
		!trusted ||
		trusted.toolboxUserId !== input.createdByUser ||
		trusted.lobuAgentId !== input.createdByAgent ||
		trusted.lobuAgentId !== input.resolvedAgentId ||
		!bounded(input.jobId, 256) ||
		!Number.isInteger(input.runId) ||
		Number(input.runId) <= 0
	) {
		return null;
	}
	return { ...trusted, jobId: input.jobId, runId: Number(input.runId) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
	return (
		typeof value === "string" && value.trim().length > 0 && value.length <= max
	);
}
