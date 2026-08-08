import { describe, expect, test } from "bun:test";
import {
	type PendingToolInvocation,
	stableReleaseAuthorizationDigest,
} from "../auth/mcp/pending-tool-store.js";
import { isPendingReleaseBindingCurrent } from "../auth/mcp/tool-approval-service.js";

// 這個檔案刻意不接資料庫：isPendingReleaseBindingCurrent 是純函式，
// 分開跑可以在毫秒內拿到訊號。
//
// 背景（2026-08-05 生產故障）：LINE 上的核准卡按下去之後工具從來沒有執行過，
// Lobu 一律回 stale。原因是發卡時存下的授權指紋，與按鈕時「重新簽發」的授權
// 指紋永遠不相等——因為 Toolbox 每次簽發都會給出新的 expiresAt，而 expiresAt
// 同時進了 stableReleaseAuthorizationDigest 與 snapshotDigest。
//
//   Toolbox  expiresAt   = min(now + 60_000, earliestCarrierExpiry)
//   Toolbox  snapshotDigest = digestAgentReleaseValue(整份 snapshot，含 expiresAt)
//   Lobu     claim.expiresAt = snapshot.expiresAt
//
// 所以「重新簽發」必然同時改變 expiresAt 與 snapshotDigest 兩個欄位。下面的
// fixture 就是照這個真實行為建的，不是假設只有 expiresAt 會動。

const BINDING_CLAIM = {
	environment: "production" as const,
	toolboxUserId: "toolbox-user-1",
	agentId: "shifu-u-1",
	releaseId: "release-1",
	releaseSequence: 1,
	snapshotDigest: `sha256:${"a".repeat(64)}`,
	// 發卡當時的 60 秒授權
	expiresAt: "2026-07-15T00:00:45.000Z",
	capabilityIds: ["semantic_tool_router.effective_inventory.v1"],
};

/** 同一顆 release、同一組 capability，但重新簽發：expiresAt 與 snapshotDigest 都換了。 */
const RENEWED_CLAIM = {
	...BINDING_CLAIM,
	snapshotDigest: `sha256:${"d".repeat(64)}`,
	expiresAt: "2026-07-15T00:02:30.000Z",
};

function pendingWithBinding(
	overrides: Partial<NonNullable<PendingToolInvocation["releaseBinding"]>> = {},
): PendingToolInvocation {
	return {
		agentId: "shifu-u-1",
		userId: "toolbox-user-1",
		mcpId: "google_workspace",
		toolName: "gws_calendar_events_create",
		args: { summary: "Demo" },
		conversationId: "conv-1",
		channelId: "line-user-1",
		connectionId: "line-connection",
		releaseBinding: {
			routerMode: "semantic",
			effectiveInventoryFingerprint: "b".repeat(64),
			releaseId: BINDING_CLAIM.releaseId,
			releaseSequence: BINDING_CLAIM.releaseSequence,
			snapshotDigest: BINDING_CLAIM.snapshotDigest,
			authorizationExpiresAt: BINDING_CLAIM.expiresAt,
			stableAuthorizationDigest:
				stableReleaseAuthorizationDigest(BINDING_CLAIM),
			eligibilityBindingDigest: "unused-by-this-function",
			...overrides,
		},
	};
}

describe("release binding 對「重新簽發」必須是穩定的", () => {
	// 使用者按下同意時已經過了 1 分半（真實的人類反應時間）。
	const pressedAt = new Date("2026-07-15T00:01:30.000Z");

	test("同一顆 release 重新簽發後仍視為 current（核准可以執行）", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{ status: "active", claim: RENEWED_CLAIM },
				pressedAt,
			),
		).toBe(true);
	});

	test("授權指紋不得隨每次簽發而改變", () => {
		// 這是上一條測試的機制層說明：指紋只該綁 release 身分，不該綁簽發時刻。
		expect(stableReleaseAuthorizationDigest(RENEWED_CLAIM)).toBe(
			stableReleaseAuthorizationDigest(BINDING_CLAIM),
		);
	});

	test("發卡時的 60 秒授權早已過期，但重新簽發的授權有效 ⇒ 仍可執行", () => {
		// 人在 LINE 上讀卡、思考、點按經常超過 60 秒。核准的存活時間由 pending 紀錄
		// 自己的 TTL 決定（oauth_states.expires_at），不該由 snapshot 的快取窗決定。
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding({
					authorizationExpiresAt: "2026-07-15T00:00:45.000Z",
				}),
				{ status: "active", claim: RENEWED_CLAIM },
				pressedAt,
			),
		).toBe(true);
	});
});

describe("release binding 仍須擋掉真正的身分變化（不可放寬過頭）", () => {
	const pressedAt = new Date("2026-07-15T00:01:30.000Z");

	test("release 前進 ⇒ stale", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{
					status: "active",
					claim: {
						...RENEWED_CLAIM,
						releaseId: "release-2",
						releaseSequence: 2,
					},
				},
				pressedAt,
			),
		).toBe(false);
	});

	test("capability 被移除 ⇒ stale", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{ status: "active", claim: { ...RENEWED_CLAIM, capabilityIds: [] } },
				pressedAt,
			),
		).toBe(false);
	});

	test("重新簽發的授權本身已過期 ⇒ stale", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{
					status: "active",
					claim: { ...RENEWED_CLAIM, expiresAt: "2026-07-15T00:01:00.000Z" },
				},
				pressedAt,
			),
		).toBe(false);
	});

	test("換人 / 換 agent ⇒ stale", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{
					status: "active",
					claim: { ...RENEWED_CLAIM, agentId: "shifu-u-other" },
				},
				pressedAt,
			),
		).toBe(false);
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{
					status: "active",
					claim: { ...RENEWED_CLAIM, toolboxUserId: "toolbox-user-other" },
				},
				pressedAt,
			),
		).toBe(false);
	});

	test("release state 不是 active ⇒ stale", () => {
		expect(
			isPendingReleaseBindingCurrent(
				pendingWithBinding(),
				{ status: "legacy_unenrolled" } as never,
				pressedAt,
			),
		).toBe(false);
	});
});
