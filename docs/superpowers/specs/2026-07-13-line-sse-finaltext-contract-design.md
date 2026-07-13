# LINE SSE Terminal `finalText` Contract Design

Date: 2026-07-13
Status: approved for planning
Target branch: `codex/line-sse-finaltext-contract`
Base: `shifu/main` at `879fd6aa0fd83bb93496d08800724ccd608bc213`

## Problem

The LINE Gateway subscribes to Lobu's direct-API SSE stream before sending a
message. For a successful turn, it accepts streamed `delta` text and treats the
matching `complete` event as terminal. When no usable delta was observed, the
Gateway relies on `complete.finalText` as the authoritative reply.

The Lobu worker already writes the complete assistant reply into the terminal
thread-response payload as `finalText`. The deployed ShiFu Lobu server rebuilds
the API SSE `complete` payload in two places, but both copies omit `finalText`.
The first empty completion therefore makes the Gateway fail with
`LobuAgentRuntimeError: Lobu agent completed without reply text`, even though the
worker produced a valid answer.

Production trace `trace_d3994897-5fe5-4ef0-8805-412c3f95e284` demonstrates the
failure: its terminal database row contains a non-empty `finalText`, while the
Gateway receives a matching completion without text. This trace contains one
user prompt; rapid user input is not the cause.

The upstream Lobu repository repaired API completion `finalText` propagation in
commit `fddb490d` (`fix(gateway): API status-message cross-pod fan-out + terminal
finalText repair (#1276)`), but that change is not an ancestor of the deployed
ShiFu revision.

## Goals

1. Preserve the worker's authoritative `finalText` through the terminal
   thread-response and API SSE boundary.
2. Emit exactly one API SSE terminal completion for each consumed terminal
   payload.
3. Make regressions fail in tests when a final-only response has no streamed
   delta.
4. Retain compatibility for older workers that omit `finalText` and for empty
   error completions.
5. Keep the change scoped to Lobu. No LINE Gateway or Toolbox behavior change is
   required.

## Non-goals

- Synchronizing the full ShiFu fork with every upstream Lobu commit.
- Redesigning the durable queue, SSE ownership registry, or worker protocol.
- Changing LINE user messaging, turn-queue behavior, or timeout policy.
- Making every streaming delta durable across replicas.
- Deploying or marking the change production-ready as part of implementation.

## Considered Approaches

### A. Add `finalText` only in `ApiResponseRenderer`

This is the smallest backport of upstream `fddb490d`. It repairs one broadcast
but leaves the direct broadcast in `UnifiedThreadResponseConsumer`, so a client
can still receive an earlier textless completion and abort before the renderer's
completion arrives.

Rejected because it does not repair the production failure deterministically.

### B. Harden the terminal contract and give the renderer sole ownership

The unified consumer delegates terminal delivery to its selected renderer.
`ApiResponseRenderer` sends one completion containing `messageId`,
`processedMessageIds`, `finalText`, and `timestamp`. Focused tests cover the
final-only path and assert that only one terminal completion is broadcast.

Selected because it backports the upstream repair while also removing the
duplicate delivery path found in the ShiFu fork.

### C. Merge current upstream Lobu

This would include the repair and many unrelated changes. The ShiFu fork has a
large, intentional divergence and a production image release process, so a full
sync would expand the review and rollout risk far beyond this incident.

Rejected for this fix. Upstream synchronization remains separate maintenance.

## Design

### Terminal payload ownership

`GatewayIntegration.signalCompletion()` remains the source of truth for the
assistant's terminal text. It sends `processedMessageIds` and `finalText` in the
worker response. No worker behavior change is expected.

`UnifiedThreadResponseConsumer` continues to classify deltas, errors, status
events, and successful completions. It must not independently broadcast the API
terminal `complete` event. Instead, it calls the selected renderer exactly once.
This keeps transport formatting inside the renderer and avoids two different
copies of the completion schema.

`ApiResponseRenderer.handleCompletion()` becomes the only successful API
completion broadcaster. Its SSE object preserves:

```ts
{
  type: "complete",
  messageId: payload.messageId,
  processedMessageIds: payload.processedMessageIds,
  finalText: payload.finalText,
  timestamp: payload.timestamp || Date.now(),
}
```

For successful completions, `finalText` may be an empty string when the worker
legitimately produced no text. It remains optional at the shared worker payload
boundary for compatibility with older workers, but the API renderer must copy
the field without re-deriving or filtering it. Consumers decide whether an
empty successful reply is valid.

### Error completion behavior

An error event remains authoritative for failures. The unified consumer calls
`handleError()` and then `handleCompletion()` once, without separately emitting
a completion. The renderer may emit an empty terminal completion after the
error so existing SSE clients can close their turn. It must not manufacture a
successful `finalText`.

### Compatibility

- Current workers: full terminal text reaches the API SSE client.
- Older workers: `finalText` is absent and remains absent; accumulated deltas
  continue to be the fallback.
- LINE Gateway: its current `authoritativeCompletionText(finalText, acc)` logic
  succeeds for final-only and streamed responses.
- Other renderers: Slack and other platform behavior is unchanged because they
  already receive the original terminal payload through the renderer interface.

## Data Flow

1. LINE Gateway subscribes to the Lobu API SSE endpoint.
2. LINE Gateway posts one user message with its trace context.
3. Lobu queues the message and the worker executes the turn.
4. The worker sends zero or more delta responses.
5. The worker sends one terminal response with `processedMessageIds` and
   authoritative `finalText`.
6. The terminal response is committed to the durable response queue.
7. `UnifiedThreadResponseConsumer` selects `ApiResponseRenderer` and delegates
   completion once.
8. `ApiResponseRenderer` emits one SSE `complete` containing `finalText`.
9. LINE Gateway matches the message ID and returns `finalText` when no delta was
   observed.

## Error Handling and Observability

- A terminal payload without `finalText` remains compatible but should be
  visible in focused debug logs or assertions without logging message content.
- The implementation must not log assistant text, user prompts, tokens, or
  credentials.
- Existing `gateway.turn.failed` handling remains unchanged; after the fix this
  failure class should disappear for valid final-only turns.
- Duplicate completion removal must not remove the preceding `error` SSE event.

## Testing Strategy

Implementation follows test-driven development.

1. Add a failing renderer test proving a completion preserves authoritative
   `finalText` when there were no deltas.
2. Add a failing unified-consumer test proving one successful terminal payload
   results in exactly one `complete` broadcast.
3. Add an error-path test proving `error` remains observable and completion is
   not duplicated.
4. Keep worker tests proving `signalCompletion()` sends authoritative
   `finalText`.
5. Run the focused server and worker suites, then the relevant package typecheck
   and `git diff --check`.
6. If feasible without production mutation, replay a captured final-only SSE
   fixture through the LINE Gateway client as a cross-repo compatibility check.

The regression seam is the real terminal boundary: worker terminal payload to
unified consumer to API renderer to captured SSE event. A shallow test that only
calls a payload helper is insufficient.

## Rollout

The change will be delivered as one ShiFu Lobu PR. It is not production-ready by
default. After review and merge, the supported deployment path is GitHub Actions
image build, GHCR publication, and Zeabur image-service update. Before moving the
public Lobu service, verify the image on a canary and ensure only one Lobu runtime
polls the production database.

After deployment, verify:

- `/health` reports the intended revision and build time.
- the running source contains `finalText` in the API completion broadcaster;
- a synthetic final-only turn yields one text-bearing SSE completion;
- LINE Gateway can consume that response without `gateway.turn.failed`;
- the architecture report is refreshed because a cross-service API event
  contract changed.

## 架構影響（Architecture Impact）

參考：[ShiFu Agent Stack 架構報告](https://pub-6d866119abba4258a28caacb0047fd73.r2.dev/shifu-agent-stack-arch)

### 涉及的模組

| 模組 | Repo | 改動性質 |
| --- | --- | --- |
| `agent-worker` | `lobu` | 讀取／驗證 terminal `finalText` 來源，不預期改行為 |
| `gateway` API renderer | `lobu` | 修改 SSE `complete` contract，保留 `finalText` |
| `gateway` unified response consumer | `lobu` | 修改 terminal delivery ownership，移除重複廣播 |
| `lobu-client` | `shifu-line-gateway` | 相容性驗證，不修改 |

### 資料流影響

影響 LINE 個人助理資料流的 Lobu worker response 到 Gateway SSE delivery
階段，也就是上述資料流步驟 5–9。身份解析、agent provisioning、訊息入列與
LINE reply dispatch 的邊界不變。

### 資料一致性注意事項

- **Lobu 多副本 SSE 路由（高風險）**：delta 仍可能在非 SSE owner replica
  被消費，因此 terminal `finalText` 必須是可跨 replica 修復輸出的權威值。
- **對話訊息雙重儲存**：本設計不改 Lobu events 或 Toolbox Supabase message
  writeback；不新增第三份訊息資料。
- **MCP 工具授權雙頭管理**：不受影響。
- **LINE 綁定狀態**：不受影響。
- **Email、onboarding、訂單與 MCP cache**：不受影響。

### 不受影響的模組

Toolbox product/runtime read model、LINE identity/bind、MCP proxy/grants、
connector、embeddings、guardrails、auth、watchers and job scheduling behavior
are outside this change.

## Success Criteria

- The production trace pattern can be replayed without
  `LobuAgentRuntimeError`.
- A final-only response emits exactly one matching SSE `complete` with the
  original `finalText`.
- A streamed response still delivers its deltas and one terminal completion.
- An error response emits its error and does not create duplicate terminal
  completion events.
- Focused tests, package typechecks, and diff checks pass.
- No changes are required in user behavior or LINE Gateway code.
