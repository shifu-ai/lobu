import type { ScheduledPersonalReminderV1 } from "./personal-reminder.js";
import { readTrustedPersonalReminder } from "./personal-reminder.js";

export type PersonalReminderCompletion =
	| { kind: "succeeded"; finalOutput: string }
	| { kind: "failed"; error: string };

export function readPersonalReminderDeliveryMetadata(
	platformMetadata: Record<string, unknown> | undefined,
): ScheduledPersonalReminderV1 | null {
	const raw = platformMetadata?.scheduledPersonalReminder;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const trusted = readTrustedPersonalReminder(row);
	if (
		!trusted ||
		!bounded(row.jobId, 256) ||
		!Number.isInteger(row.runId) ||
		Number(row.runId) <= 0
	) {
		return null;
	}
	return { ...trusted, jobId: row.jobId, runId: Number(row.runId) };
}

export async function deliverPersonalReminderCompletion(
	input: {
		metadata: ScheduledPersonalReminderV1;
		completion: PersonalReminderCompletion;
		turnId: string;
		occurredAt: string;
	},
	deps: { fetchFn?: typeof fetch } = {},
): Promise<void> {
	const url = process.env.TOOLBOX_TURN_COMPLETED_URL?.trim();
	const secret = process.env.TOOLBOX_INTERNAL_SECRET?.trim();
	if (!url || !secret)
		throw new Error("personal_reminder_delivery_not_configured");
	if (!bounded(input.turnId, 256) || !validIso(input.occurredAt)) {
		throw new Error("personal_reminder_delivery_invalid_completion");
	}
	if (
		input.completion.kind === "succeeded" &&
		(!input.completion.finalOutput.trim() ||
			input.completion.finalOutput.length > 50_000)
	) {
		throw new Error("personal_reminder_delivery_invalid_completion");
	}
	if (
		input.completion.kind === "failed" &&
		!bounded(input.completion.error, 2_000)
	) {
		throw new Error("personal_reminder_delivery_invalid_completion");
	}
	const completionPayload =
		input.completion.kind === "succeeded"
			? {
					completionStatus: "succeeded",
					finalOutput: input.completion.finalOutput,
				}
			: { completionStatus: "failed", error: input.completion.error };
	const response = await (deps.fetchFn ?? fetch)(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-internal-secret": secret,
		},
		body: JSON.stringify({
			...input.metadata,
			turnId: input.turnId,
			occurredAt: input.occurredAt,
			...completionPayload,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const body = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	if (response.status === 503 && body.status === "retrying") {
		throw new Error("personal_reminder_delivery_retrying");
	}
	if (
		!response.ok ||
		![
			"delivered",
			"delivery_blocked_unbound",
			"failed",
			"delivery_unknown",
			"retrying",
		].includes(String(body.status))
	) {
		throw new Error(`personal_reminder_delivery_failed:${response.status}`);
	}
}

function validIso(value: string): boolean {
	return bounded(value, 64) && !Number.isNaN(new Date(value).getTime());
}

function bounded(value: unknown, max: number): value is string {
	return (
		typeof value === "string" && value.trim().length > 0 && value.length <= max
	);
}
