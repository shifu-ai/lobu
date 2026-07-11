import { beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../../../tools/registry";
import { search } from "../../../tools/search";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEvent,
	createTestOrganization,
	createTestUser,
	seedSystemEntityTypes,
} from "../../setup/test-fixtures";

describe("search_memory > exact course entity scope", () => {
	const agentId = "shifu-u-scope-test";
	const courseA = "course:user-001:a";
	const courseB = "course:user-001:b";
	let ctx: ToolContext;
	let activeAId: number;
	let activeBId: number;
	let replacementId: number;

	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
		await seedSystemEntityTypes();
		const org = await createTestOrganization({ name: "Course Scope Org" });
		const user = await createTestUser({ email: "course-scope@example.com" });
		await addUserToOrganization(user.id, org.id, "owner");
		ctx = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			agentId,
			isAuthenticated: true,
			tokenType: "oauth",
			scopedToOrg: true,
			allowCrossOrg: false,
			scopes: ["mcp:read"],
		} as ToolContext;
		activeAId = (
			await createTestEvent({
				organization_id: org.id,
				content: "Key Learning shared phrase active course A",
				metadata: {
					agent_id: agentId,
					owner_user_id: user.id,
					course_entity_ids: [courseA],
					course_entity_id: courseA,
				},
			})
		).id;
		activeBId = (
			await createTestEvent({
				organization_id: org.id,
				content: "Key Learning shared phrase active course B",
				metadata: {
					agent_id: agentId,
					owner_user_id: user.id,
					course_entity_ids: [courseB],
					course_entity_id: courseB,
				},
			})
		).id;
		const superseded = await createTestEvent({
			organization_id: org.id,
			content: "Key Learning shared phrase obsolete course A",
			metadata: {
				agent_id: agentId,
				owner_user_id: user.id,
				course_entity_ids: [courseA],
				course_entity_id: courseA,
			},
		});
		replacementId = (
			await createTestEvent({
				organization_id: org.id,
				content: "Key Learning shared phrase replacement course A",
				metadata: {
					agent_id: agentId,
					owner_user_id: user.id,
					course_entity_ids: [courseA],
					course_entity_id: courseA,
				},
			})
		).id;
		await getTestDb()`UPDATE events SET supersedes_event_id = ${superseded.id} WHERE id = ${replacementId}`;
	});

	it("filters exact course scope in SQL before ranking and excludes superseded rows", async () => {
		const result = await search(
			{
				query: "Key Learning shared phrase",
				include_content: true,
				content_limit: 8,
				agent_id: agentId,
				entity_ids: [courseA],
			} as never,
			{} as never,
			ctx,
		);
		const ids = (result.content ?? []).map((item) => item.id);
		expect(ids).toContain(activeAId);
		expect(ids).toContain(replacementId);
		expect(ids).not.toContain(activeBId);
	});

	it.each([
		[["course:user-001:bad id"]],
		[[1]],
		[Array.from({ length: 21 }, (_, index) => `course:${index}`)],
	])("rejects malformed entity_ids %j", async (entityIds) => {
		await expect(
			search(
				{ query: "Key Learning", entity_ids: entityIds } as never,
				{} as never,
				ctx,
			),
		).rejects.toThrow(/entity_ids/i);
	});
});
