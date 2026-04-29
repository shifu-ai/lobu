# Platform-agnostic context backfill + session lifecycle

Status: draft / awaiting approval
Owner: gateway/connections
Branch: `feat/platform-context-backfill` (NOT current `fix/watcher-pipeline-reliability` — switch first)

## Why

Today the bot has two real gaps in conversation context:

1. **Channel scrollback is invisible.** When the bot is @mentioned at the top of a channel, `message-handler-bridge.ts:464` calls `adapter.fetchMessages(thread.id, ...)` which on Slack maps to `conversations.replies` (thread-only). The mention's own `thread_ts == ts`, so backfill returns just the mention itself — zero prior channel context, even though `channels:history` is granted in OAuth (`slack.ts:14-33`). The Slack adapter already exposes `fetchChannelMessages(channelId, ...)` (calls `conversations.history`), but the gateway never invokes it.
2. **Cross-session memory is lossy.** Redis sliding window is 10 messages, 24h TTL, plaintext only (`conversation-state-store.ts:26-27, :120`). After 10 turns or 24h of silence, the agent is amnesiac. Worker `session.jsonl` has the full picture but only persists per `(channel, thread)` and is meaningless for "what did we discuss yesterday in #general."

This must work across **all** platforms (Slack, Telegram, Discord, Teams, GChat, WhatsApp), not just Slack. The chat-adapter SDK (`chat@4.26.0`) is upstream — we don't own that interface — so we add a **local capability layer** in the gateway that dispatches to each adapter's native channel-scope API.

## Scope

This is one concern, but sized for **two PRs** because PR 1 is shippable independently and PR 2 requires the embedded-mode + Owletto plumbing the user is also designing.

### PR 1 — Platform-agnostic channel-context backfill (this plan)

Foundational. No deployment-mode changes, no Owletto changes. Just close the channel-scrollback gap and make the existing backfill platform-agnostic with proper tests.

### PR 2 — Session lifecycle & long-term memory (separate plan, follow-up)

Embedded-mode native: drop Redis 10-message window, make `session.jsonl` authoritative, add inactivity-driven compaction → Owletto knowledge, support `/new` command. Depends on PR 1.

The rest of this doc is **PR 1 only**.

---

## Design — PR 1

### 1. Local capability dispatcher

New file: `packages/gateway/src/connections/adapter-capabilities.ts`

```ts
export interface ChannelHistoryFetcher {
  fetchChannelMessages(channelId: string, options: FetchOptions): Promise<FetchResult<unknown>>;
}

export function getChannelHistoryFetcher(adapter: unknown): ChannelHistoryFetcher | null {
  // Duck-typed dispatch. Returns null when platform has no read-back API
  // (e.g. WhatsApp), so caller can degrade gracefully.
  if (!adapter || typeof adapter !== "object") return null;
  if (typeof (adapter as any).fetchChannelMessages === "function") {
    return adapter as ChannelHistoryFetcher;     // Slack today
  }
  // Telegram: fetchMessages is already chat-scoped (no thread distinction).
  // Discord, Teams, GChat: implement adapters here as we wire each platform.
  return null;
}
```

This stays in gateway code, not in the upstream `chat` package. We can upstream a unified interface later; for now we just need to ship.

### 2. Update backfill in `message-handler-bridge.ts`

At `:446-506`, the existing `claimThreadBackfill` block becomes a single dispatch:

- **Top-level mention in a channel** (`thread.id == messageId` AND `isGroup`):
  - First try `getChannelHistoryFetcher(adapter)?.fetchChannelMessages(channelId, { limit: 50, direction: "backward" })`
  - If that returned messages, append them; if `null` (unsupported platform), fall through silently.
- **In-thread mention** (`thread.id != messageId`):
  - Existing `adapter.fetchMessages(thread.id, ...)` — thread replies. Already correct.
- **DMs**: skip backfill (current behavior, `:238`).

Same one-shot lock semantics via `claimThreadBackfill`. Lock key needs adjusting so channel-scope and thread-scope claims don't collide — see §3.

### 3. Fix backfill lock poisoning

Bug independent of the channel/thread split: if the backfill API call throws, `releaseThreadBackfill` runs (`:500-505`) — but **only when `backfillSucceeded === false` AND we hit the catch**. The control flow at `:494-498` already logs the error and falls through, then `:500` checks `!backfillSucceeded` and releases. That part's actually correct.

Real bug: when adapter has no `fetchMessages` (`:489-493`), we set `backfillSucceeded = true`. That's fine. **But** if the lock claim succeeds and the process crashes between `claimThreadBackfill` and either branch finishing, the lock sits for 24h with no release.

Fix: shorten the unsuccessful-claim TTL. New helper `claimThreadBackfill` returns the claim with a short lease (e.g. 60s); on success, extend to `HISTORY_TTL_MS`; on crash, lease expires fast and next event retries. Implementation: two-step Redis SETEX — initial `SETEX 60s "in-flight"`, then on success `SETEX 86400s "done"`.

### 4. Tests (`bun test`, runs in CI)

Extend `packages/gateway/src/__tests__/message-handler-bridge.test.ts` (already has the harness):

- `top-level mention with channel-scope adapter calls fetchChannelMessages` — assert `fetchChannelMessages` invoked, not `fetchMessages`.
- `in-thread mention falls back to fetchMessages` — preserves existing behavior.
- `top-level mention without channel fetcher capability is no-op` — null fetcher path, no errors.
- `top-level mention with channel fetch failure releases lease` — claim recoverable on next event, not 24h poisoned.
- `lease auto-expires after 60s when process crashes mid-backfill` — fake-timer test on `conversation-state-store`.
- `mixed source events for same thread don't double-backfill` — race two simultaneous events, only one fetch.

Per-adapter capability tests:
- `adapter-capabilities.test.ts` — Slack adapter exposes fetcher; WhatsApp/Telegram return null (until each is wired).

Integration:
- `chat-instance-manager-slack.test.ts` already in place — extend to assert end-to-end backfill includes channel scrollback for top-level mention.

No vitest-only tests; all runs through `bun test` so CI picks them up.

### 5. Out of scope for this PR

- Embedded-mode session storage changes
- Owletto knowledge writes
- `/new` command
- Compaction / summarization
- Telegram/Discord/Teams/GChat fetcher implementations (wire as those platforms get exercised; Slack alone unblocks the user's main use case)
- Upstreaming a unified channel-fetch interface to `chat-adapter`

---

## Branch + commit plan

1. `git switch main && git pull --ff-only`
2. `git switch -c feat/platform-context-backfill`
3. Commit 1: `feat(gateway): add adapter channel-history capability dispatcher` — new `adapter-capabilities.ts`, types only.
4. Commit 2: `feat(gateway): backfill channel scrollback on top-level mention` — wire dispatcher into `message-handler-bridge.ts`, behavior change.
5. Commit 3: `fix(gateway): release backfill lease on crash via short initial TTL` — `conversation-state-store.ts` two-step lease.
6. Commit 4: `test(gateway): cover channel-scope backfill paths and lease recovery` — `bun test` extensions.

PR title: `feat(gateway): channel-scope backfill on @mention with proper lease recovery`.

## Validation

- `make build-packages` (TypeScript check across gateway/core/worker).
- `cd packages/gateway && bun test src/__tests__/message-handler-bridge.test.ts` — fast loop.
- `bun run typecheck` — full repo.
- `./scripts/test-bot.sh "@me what's the context here?"` posted as a top-level mention in a channel with prior chatter; assert agent references prior messages.

## Risks

- **Channel `:history` calls are Tier 3 in Slack** (~50 req/min). Backfill is one-shot per thread per 24h, well under the limit, but worth noting.
- **Privacy.** Channel scrollback may include messages from users who didn't directly engage the bot. The backfilled text already lives in the bot's accessible OAuth scope, so this isn't a new privilege escalation, but it does mean *more* messages are passed to the worker → LLM → potentially Owletto memory. PR 2's compaction step should make the trust boundary explicit.
- **Lease recovery** changes lock semantics — existing tests should pin behavior so we don't regress the race protection.

## Open questions

- Limit: 50 channel messages on first mention — enough? Configurable per-agent?
- Channel-scope direction: `backward` from mention `ts` (most recent N before the mention) is what we want. Confirm Slack adapter `direction: "backward"` returns chronological order (oldest-first within the page) — it does per the SDK docstring.
- Should DMs get a small backfill too (last N DM messages before the current one)? Currently no. Probably defer to PR 2's compaction story.
