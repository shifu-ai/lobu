# LINE SSE Terminal `finalText` Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver exactly one Lobu API SSE terminal completion containing the worker's authoritative `finalText`, including final-only turns with no streamed delta.

**Architecture:** Keep `ThreadResponsePayload.finalText` as the source of truth, make `ApiResponseRenderer` the sole owner of API SSE terminal formatting, and remove duplicate direct terminal broadcasts from `UnifiedThreadResponseConsumer`. Lock this boundary with a real consumer-to-renderer test and a required-property completion type.

**Tech Stack:** TypeScript, Bun test runner, Lobu `ThreadResponsePayload`, `UnifiedThreadResponseConsumer`, `ApiResponseRenderer`, in-memory `SseManager` test doubles.

---

## File Map

- Create `packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`: terminal payload → unified consumer → real API renderer → captured SSE regression seam.
- Modify `packages/server/src/gateway/api/response-renderer.ts`: require and preserve the `finalText` property.
- Modify `packages/server/src/gateway/platform/unified-thread-consumer.ts`: delegate terminal delivery once.
- Verify `packages/agent-worker/src/__tests__/final-text-authoritative.test.ts`: worker-side authoritative-text proof.

### Task 1: Tracer bullet — final-only response reaches SSE once

**Files:**
- Create: `packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`
- Modify: `packages/server/src/gateway/api/response-renderer.ts:65-95`
- Modify: `packages/server/src/gateway/platform/unified-thread-consumer.ts:313-324`

- [ ] **Step 1: Install dependencies if absent**

Run: `test -d node_modules || bun install --frozen-lockfile`

Expected: exit 0. Do not initialize or build the unavailable Owletto submodule.

- [ ] **Step 2: Write the failing end-to-end terminal test**

Create `packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { ThreadResponsePayload } from "@lobu/core";
import { ApiResponseRenderer } from "../response-renderer.js";
import { UnifiedThreadResponseConsumer } from "../../platform/unified-thread-consumer.js";

type Broadcast = {
  key: string;
  event: string;
  data: Record<string, unknown>;
};

function createHarness() {
  const broadcasts: Broadcast[] = [];
  const sseManager = {
    broadcast: mock(
      (key: string, event: string, data: Record<string, unknown>) => {
        broadcasts.push({ key, event, data });
      }
    ),
    hasActiveConnection: mock(() => true),
  };
  const renderer = new ApiResponseRenderer(sseManager as never);
  const platformRegistry = {
    get: mock(() => ({ getResponseRenderer: () => renderer })),
  };
  const queue = {
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    createQueue: mock(async () => undefined),
    work: mock(async () => undefined),
  };
  const consumer = new UnifiedThreadResponseConsumer(
    queue as never,
    platformRegistry as never,
    sseManager as never
  ) as unknown as {
    handleThreadResponse(job: {
      id: string;
      data: ThreadResponsePayload;
    }): Promise<void>;
  };
  return { broadcasts, consumer };
}

function terminalPayload(
  overrides: Partial<ThreadResponsePayload> = {}
): ThreadResponsePayload {
  return {
    messageId: "message-1",
    channelId: "api:user-1",
    conversationId: "conversation-1",
    userId: "user-1",
    teamId: "api",
    platform: "api",
    timestamp: 1_000,
    processedMessageIds: ["message-1"],
    finalText: "請選擇這次要處理的課程",
    platformMetadata: { sessionId: "conversation-1" },
    ...overrides,
  };
}

describe("API terminal completion contract", () => {
  test("delivers one final-only completion with authoritative finalText", async () => {
    const { broadcasts, consumer } = createHarness();

    await consumer.handleThreadResponse({
      id: "terminal-job-1",
      data: terminalPayload(),
    });

    const completions = broadcasts.filter(({ event }) => event === "complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toEqual({
      key: "conversation-1",
      event: "complete",
      data: {
        type: "complete",
        messageId: "message-1",
        processedMessageIds: ["message-1"],
        finalText: "請選擇這次要處理的課程",
        timestamp: 1_000,
      },
    });
  });
});
```

- [ ] **Step 3: Run the tracer test and verify RED**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`

Expected: FAIL because two `complete` broadcasts are observed and the renderer completion lacks `finalText`. Repair setup errors until it fails for this behavior.

- [ ] **Step 4: Require and preserve `finalText`**

Add above `ApiResponseRenderer`:

```ts
interface ApiCompletionEvent {
  type: "complete";
  messageId: string;
  processedMessageIds: string[] | undefined;
  finalText: string | undefined;
  timestamp: number;
}
```

Replace the inline completion broadcast:

```ts
const completion = {
  type: "complete",
  messageId: payload.messageId,
  processedMessageIds: payload.processedMessageIds,
  finalText: payload.finalText,
  timestamp: payload.timestamp || Date.now(),
} satisfies ApiCompletionEvent;

this.sseManager.broadcast(sessionId, "complete", completion);
```

The property is required even when its value is `undefined`, so omission fails typechecking while older workers remain compatible.

- [ ] **Step 5: Remove the direct successful completion broadcast**

Replace the successful branch with:

```ts
if (data.processedMessageIds?.length) {
  await renderer.handleCompletion(data, sessionKey);
}
```

- [ ] **Step 6: Verify GREEN**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`

Expected: 1 test passes with one text-bearing completion.

- [ ] **Step 7: Run existing consumer tests**

Run: `bun test packages/server/src/gateway/__tests__/unified-thread-consumer.test.ts`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts packages/server/src/gateway/api/response-renderer.ts packages/server/src/gateway/platform/unified-thread-consumer.ts
git commit -m "fix(gateway): preserve API terminal finalText"
```

### Task 2: Error and older-worker compatibility without duplicates

**Files:**
- Modify: `packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`
- Modify: `packages/server/src/gateway/platform/unified-thread-consumer.ts:286-310`

- [ ] **Step 1: Add the failing error-path test**

Append inside the existing `describe`:

```ts
test("delivers one error sequence and one terminal completion", async () => {
  const { broadcasts, consumer } = createHarness();

  await consumer.handleThreadResponse({
    id: "terminal-error-job",
    data: terminalPayload({
      finalText: undefined,
      error: "provider unavailable",
    }),
  });

  expect(broadcasts.filter(({ event }) => event === "error")).toHaveLength(1);
  expect(broadcasts.filter(({ event }) => event === "agent-error")).toHaveLength(1);
  expect(broadcasts.filter(({ event }) => event === "complete")).toHaveLength(1);
  expect(broadcasts.find(({ event }) => event === "complete")?.data).toEqual({
    type: "complete",
    messageId: "message-1",
    processedMessageIds: ["message-1"],
    finalText: undefined,
    timestamp: 1_000,
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts -t "delivers one error sequence"`

Expected: FAIL because the consumer emits extra `error` and `complete` events.

- [ ] **Step 3: Give the renderer sole ownership of error SSE formatting**

Replace the error branch with:

```ts
if (data.error) {
  await renderer.handleError(data, sessionKey);
  await renderer.handleCompletion(data, sessionKey);
  return;
}
```

- [ ] **Step 4: Verify GREEN**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts -t "delivers one error sequence"`

Expected: 1 matching test passes.

- [ ] **Step 5: Add older-worker compatibility coverage**

```ts
test("preserves an explicit undefined finalText for an older worker", async () => {
  const { broadcasts, consumer } = createHarness();

  await consumer.handleThreadResponse({
    id: "legacy-terminal-job",
    data: terminalPayload({ finalText: undefined }),
  });

  const completions = broadcasts.filter(({ event }) => event === "complete");
  expect(completions).toHaveLength(1);
  expect(completions[0].data).toHaveProperty("finalText");
  expect(completions[0].data.finalText).toBeUndefined();
});
```

- [ ] **Step 6: Prove the compatibility guard**

Temporarily remove only `finalText: payload.finalText`, then run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts -t "older worker"`

Expected: the `satisfies ApiCompletionEvent` check and/or test fails. Restore the line before continuing.

- [ ] **Step 7: Run the contract suite**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`

Expected: 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts packages/server/src/gateway/platform/unified-thread-consumer.ts
git commit -m "test(gateway): cover terminal SSE compatibility"
```

### Task 3: Full verification and production-trace regression evidence

**Files:**
- Verify: `packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`
- Verify: `packages/server/src/gateway/__tests__/unified-thread-consumer.test.ts`
- Verify: `packages/agent-worker/src/__tests__/final-text-authoritative.test.ts`

- [ ] **Step 1: Run worker authoritative-text tests**

Run: `bun test packages/agent-worker/src/__tests__/final-text-authoritative.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Run terminal boundary suites together**

Run: `bun test packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts packages/server/src/gateway/__tests__/unified-thread-consumer.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run the broader gateway suite**

Run: `bun test packages/server/src/gateway`

Expected: all tests pass. Reproduce any suspected pre-existing failure on `shifu/main` before classifying it as unrelated.

- [ ] **Step 4: Typecheck affected packages**

Run: `bun run --cwd packages/core typecheck`

Run: `bun run --cwd packages/server typecheck`

Expected: both exit 0.

- [ ] **Step 5: Verify formatting and patch hygiene**

Run: `bunx biome check --config-path config/biome.config.json packages/server/src/gateway/api/response-renderer.ts packages/server/src/gateway/platform/unified-thread-consumer.ts packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`

Run: `git diff --check shifu/main...HEAD`

Expected: both exit 0.

- [ ] **Step 6: Inspect scope**

Run: `git diff --stat shifu/main...HEAD`

Run: `git diff shifu/main...HEAD -- packages/server/src/gateway/api/response-renderer.ts packages/server/src/gateway/platform/unified-thread-consumer.ts packages/server/src/gateway/api/__tests__/terminal-completion-contract.test.ts`

Expected: runtime changes are limited to `finalText` propagation and renderer ownership; no Toolbox, LINE Gateway, database, prompt, MCP, or deployment files change.

- [ ] **Step 7: Commit only if verification required corrections**

```bash
git add packages/server/src/gateway
git commit -m "test(gateway): harden terminal SSE regression coverage"
```

If clean, do not create an empty commit.

## Completion Gate

Before opening a PR, compare every design success criterion against the final diff and fresh output, dispatch a final reviewer across `shifu/main...HEAD`, resolve all Critical and Important findings, and use `finishing-a-development-branch`. Do not push, merge, build an image, or deploy without explicit user authorization.
