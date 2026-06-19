import assert from "node:assert/strict";
import test from "node:test";
import {
	deterministicMembershipId,
	deterministicToolboxOwnerEmail,
	parseArgs,
	toSummaryRows,
} from "./repair-toolbox-personal-agent-memberships.mjs";

test("parseArgs defaults to dry-run with a bounded limit", () => {
	assert.deepEqual(parseArgs([]), { apply: false, limit: 500 });
});

test("parseArgs accepts apply mode and explicit limits", () => {
	assert.deepEqual(parseArgs(["--apply", "--limit", "20"]), {
		apply: true,
		limit: 20,
	});
});

test("parseArgs rejects unsafe limits", () => {
	assert.throws(
		() => parseArgs(["--limit", "10001"]),
		/--limit must be an integer from 1 to 10000/,
	);
});

test("deterministic ids and emails are stable and non-raw", () => {
	assert.equal(
		deterministicMembershipId("org_test", "toolbox-user-1"),
		deterministicMembershipId("org_test", "toolbox-user-1"),
	);
	assert.match(
		deterministicMembershipId("org_test", "toolbox-user-1"),
		/^member_[a-f0-9]{24}$/,
	);

	const email = deterministicToolboxOwnerEmail("org_test", "toolbox-user-1");
	assert.match(email, /^toolbox-owner-[a-f0-9]{32}@toolbox\.local$/);
	assert(!email.includes("toolbox-user-1"));
});

test("summary rows include only non-secret repair fields", () => {
	assert.deepEqual(
		toSummaryRows([
			{
				agent_id: "shifu-u-alpha",
				organization_id: "org_test",
				owner_user_id: "toolbox-user-1",
			},
		]),
		[
			{
				agentId: "shifu-u-alpha",
				organizationId: "org_test",
				ownerUserId: "toolbox-user-1",
				role: "member",
			},
		],
	);
});
