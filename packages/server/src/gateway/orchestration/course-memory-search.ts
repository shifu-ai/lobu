import { getDb, pgBigintArray } from "../../db/client.js";
import { searchContentByText } from "../../utils/content-search.js";

export async function searchCourseMemoryRows(input: {
	organizationId: string;
	ownerUserId: string;
	agentId: string;
	entityIds: string[];
	query: string;
	limit: number;
}): Promise<unknown> {
	const result = await searchContentByText(input.query, {
		organization_id: input.organizationId,
		visibility_scope: {
			organizationId: input.organizationId,
			userId: input.ownerUserId,
		},
		agent_id: input.agentId,
		course_entity_ids: input.entityIds,
		limit: input.limit,
		sort_by: "score",
		approximate_candidate_search: true,
	});
	const ids = result.content.slice(0, input.limit).map((row) => row.id);
	if (ids.length === 0) return [];
	const idsLiteral = pgBigintArray(ids);
	return await getDb()`
    SELECT event.id, event.payload_text, event.title, event.source_url, event.organization_id, event.metadata
    FROM current_event_records event
    LEFT JOIN connections connection ON connection.id = event.connection_id
    WHERE event.id = ANY(${idsLiteral}::bigint[])
      AND event.organization_id = ${input.organizationId}
      AND (event.connection_id IS NULL OR (
        connection.organization_id = ${input.organizationId}
        AND connection.deleted_at IS NULL
        AND (connection.visibility = 'org' OR connection.created_by = ${input.ownerUserId})
      ))
    ORDER BY array_position(${idsLiteral}::bigint[], event.id)
  `;
}
