/**
 * SHIFU FORK: member-scope-internal-tools plan, Task 3 follow-up.
 *
 * Production bug (2026-07): an agent scheduling its own wake_agent via LINE
 * doesn't know its own bare agent id and fills manage_schedules' `agent_id`
 * with the full CONVERSATION id instead (`<agentId>_<userId>_<threadId>`).
 * `resolveWakeAgentId` normalizes either shape down to the bare `agents.id`
 * so schedule create (manage_schedules.ts) and wake-fire (jobs.ts) both see
 * a clean id. Agent ids never contain an underscore
 * (`/^shifu-u-[a-z0-9-]+$/`); conversation ids are underscore-joined, so the
 * bare id is always the longest `agents.id` row that is a `<id>_`-prefix of
 * the given string.
 */
import { describe, expect, test } from "bun:test";
import { resolveWakeAgentId, type SqlLike } from "../scheduled-jobs-service";

interface FakeAgentRow {
  id: string;
  organization_id: string;
}

/**
 * Minimal in-memory stand-in for postgres.js's tagged-template `sql`. Real
 * production queries are exact-id-then-LIKE-prefix (see resolveWakeAgentId);
 * this fake distinguishes the two by the presence of "LIKE" in the query
 * text and replicates the same matching semantics against a fixture table,
 * so tests assert on behavior rather than on bound-parameter positions.
 */
function makeSql(rows: FakeAgentRow[]): SqlLike {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("");
    if (text.includes("LIKE")) {
      const [organizationId, rawAgentId] = values as [string, string];
      const candidates = rows
        .filter(
          (r) =>
            r.organization_id === organizationId &&
            rawAgentId.startsWith(`${r.id}_`)
        )
        .sort((a, b) => b.id.length - a.id.length);
      return candidates.length > 0 ? [{ id: candidates[0].id }] : [];
    }
    const [rawAgentId, organizationId] = values as [string, string];
    const match = rows.find(
      (r) => r.id === rawAgentId && r.organization_id === organizationId
    );
    return match ? [{ id: match.id }] : [];
  }) as unknown as SqlLike;
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const BARE_AGENT_ID = "shifu-u-302b8bcc3af1";

describe("resolveWakeAgentId", () => {
  test("exact bare agent id → returns it unchanged (fast path)", async () => {
    const sql = makeSql([{ id: BARE_AGENT_ID, organization_id: ORG }]);
    const result = await resolveWakeAgentId(sql, ORG, BARE_AGENT_ID);
    expect(result).toBe(BARE_AGENT_ID);
  });

  test("conversation-id form (agentId_userId_threadId) → returns the bare agent id", async () => {
    const sql = makeSql([{ id: BARE_AGENT_ID, organization_id: ORG }]);
    const conversationId = `${BARE_AGENT_ID}_beaac6ef-917b-4bfd-b024-67555d19f0c1_org_peRVYvsqsWk`;
    const result = await resolveWakeAgentId(sql, ORG, conversationId);
    expect(result).toBe(BARE_AGENT_ID);
  });

  test("unknown id (no exact match, no prefix match) → null", async () => {
    const sql = makeSql([{ id: BARE_AGENT_ID, organization_id: ORG }]);
    const result = await resolveWakeAgentId(sql, ORG, "shifu-u-does-not-exist");
    expect(result).toBeNull();
  });

  test("conversation-id whose bare agent belongs to a DIFFERENT organization → null (org-scoped)", async () => {
    const sql = makeSql([{ id: BARE_AGENT_ID, organization_id: OTHER_ORG }]);
    const conversationId = `${BARE_AGENT_ID}_some-user_some-thread`;
    const result = await resolveWakeAgentId(sql, ORG, conversationId);
    expect(result).toBeNull();
  });

  test("a raw string that merely starts with a shorter agent id but has no underscore boundary → null (no false-positive substring match)", async () => {
    // "shifu-u-abc" is NOT a prefix-with-boundary of "shifu-u-abcdef" — the
    // LIKE pattern requires the literal '_' immediately after the id.
    const sql = makeSql([{ id: "shifu-u-abc", organization_id: ORG }]);
    const result = await resolveWakeAgentId(sql, ORG, "shifu-u-abcdef");
    expect(result).toBeNull();
  });

  test("picks the LONGEST matching agent id when multiple agents' ids are prefixes of each other", async () => {
    // e.g. "shifu-u-a" and "shifu-u-a-b" both agents; conversation id built
    // from "shifu-u-a-b" must resolve to the longer, more specific id.
    const sql = makeSql([
      { id: "shifu-u-a", organization_id: ORG },
      { id: "shifu-u-a-b", organization_id: ORG },
    ]);
    const conversationId = "shifu-u-a-b_user-1_thread-1";
    const result = await resolveWakeAgentId(sql, ORG, conversationId);
    expect(result).toBe("shifu-u-a-b");
  });
});
