const MAX_LOG_IDENTIFIER_LENGTH = 128;

function boundedIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized
		? normalized.slice(0, MAX_LOG_IDENTIFIER_LENGTH)
		: undefined;
}

export function salesBattleReportObserverLogFields(
	payload: unknown,
): Record<string, string | number> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return {};

	const input = payload as Record<string, unknown>;
	const fields: Record<string, string | number> = {};
	const toolboxScheduleId = boundedIdentifier(input.toolboxScheduleId);
	const agentId = boundedIdentifier(input.agentId);
	if (toolboxScheduleId) fields.toolboxScheduleId = toolboxScheduleId;
	if (agentId) fields.agentId = agentId;
	if (
		Number.isSafeInteger(input.scheduleRevision) &&
		Number(input.scheduleRevision) >= 1 &&
		Number(input.scheduleRevision) <= 2_147_483_647
	) {
		fields.scheduleRevision = input.scheduleRevision as number;
	}
	if (
		Number.isInteger(input.salesTalkWeekday) &&
		Number(input.salesTalkWeekday) >= 0 &&
		Number(input.salesTalkWeekday) <= 6
	) {
		fields.salesTalkWeekday = input.salesTalkWeekday as number;
	}
	return fields;
}
