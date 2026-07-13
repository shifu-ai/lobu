const CALLER_RESERVED_PROVENANCE_KEYS = [
	"evidence_kind",
	"source_kind",
	"source_type",
] as const;

export function stripCallerEvidenceProvenance(
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const sanitized = { ...(metadata ?? {}) };
	for (const key of CALLER_RESERVED_PROVENANCE_KEYS) delete sanitized[key];
	return sanitized;
}

export interface SystemEvidenceRecord {
	connection_id?: number | null;
	connector_key?: string | null;
	origin_id?: string | null;
	origin_type?: string | null;
	semantic_type?: string | null;
}

/**
 * Derive evidence provenance only from event columns stamped by connector or
 * server ingestion. Arbitrary save_memory/context-pack metadata is excluded.
 */
export function verifiedEvidenceKind(
	record: SystemEvidenceRecord,
): "meeting" | "transcript" | undefined {
	if (
		!Number.isSafeInteger(record.connection_id) ||
		Number(record.connection_id) <= 0 ||
		typeof record.connector_key !== "string" ||
		!record.connector_key.trim()
	) {
		return undefined;
	}
	const semanticType = record.semantic_type?.trim().toLowerCase();
	const originType = record.origin_type?.trim().toLowerCase();
	if (record.origin_id?.endsWith("#transcript")) return "transcript";
	if (
		semanticType === "transcript" ||
		semanticType === "meeting_transcript" ||
		originType === "transcript" ||
		originType === "meeting_transcript"
	) {
		return "transcript";
	}
	if (
		semanticType === "meeting" ||
		semanticType === "meeting_notes" ||
		originType === "meeting" ||
		originType === "meeting_notes"
	) {
		return "meeting";
	}
	return undefined;
}
