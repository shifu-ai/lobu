import { describe, expect, test } from "bun:test";
import {
  buildContextOverflowRecoveryMessage,
  formatContextOverflowExecutionError,
  isContextOverflowError,
  toUserVisibleSessionError,
} from "../openclaw/context-overflow-recovery";

describe("context overflow recovery", () => {
  test("recognizes provider prompt length errors", () => {
    expect(
      isContextOverflowError(
        '400 {"message":"prompt is too long: 205846 tokens > 200000 maximum"}'
      )
    ).toBe(true);
    expect(
      isContextOverflowError(
        '400 {"message":"prompt too long: 205846 tokens > 200000 maximum"}'
      )
    ).toBe(true);
  });

  test("does not treat unrelated auth/tool failures as context overflow", () => {
    expect(
      isContextOverflowError(
        '401 {"message":"No provider credentials configured"}'
      )
    ).toBe(false);
    expect(isContextOverflowError("Tool call failed: permission denied")).toBe(
      false
    );
  });

  test("builds a short recovery message without provider internals", () => {
    const message = buildContextOverflowRecoveryMessage();

    expect(message).toContain("分段");
    expect(message).not.toContain("tokens");
    expect(message).not.toContain("request_id");
    expect(message).not.toContain("205846");
  });

  test("maps raw provider context overflow JSON to the recovery message", () => {
    const raw =
      '400 {"message":"prompt is too long: 205846 tokens > 200000 maximum","request_id":"req_123"}';

    expect(toUserVisibleSessionError(raw)).toBe(
      buildContextOverflowRecoveryMessage()
    );
    expect(toUserVisibleSessionError(raw)).not.toContain("request_id");
  });

  test("keeps non-context errors unchanged", () => {
    const raw = '401 {"message":"No provider credentials configured"}';

    expect(toUserVisibleSessionError(raw)).toBe(raw);
  });

  test("formats context overflow execution errors without crash prefix", () => {
    const raw =
      '400 {"message":"prompt is too long: 205846 tokens > 200000 maximum","request_id":"req_123"}';
    const message = formatContextOverflowExecutionError(new Error(raw));

    expect(message).toBe(buildContextOverflowRecoveryMessage());
    expect(message).toContain("分段");
    expect(message).not.toContain("💥 Worker crashed");
    expect(message).not.toContain("tokens");
    expect(message).not.toContain("205846");
    expect(message).not.toContain("request_id");
  });

  test("formats an existing recovery message without crash prefix", () => {
    const message = formatContextOverflowExecutionError(
      new Error(buildContextOverflowRecoveryMessage())
    );

    expect(message).toBe(buildContextOverflowRecoveryMessage());
    expect(message).toContain("分段");
    expect(message).not.toContain("💥 Worker crashed");
  });

  test("does not format unrelated execution errors as context overflow", () => {
    expect(formatContextOverflowExecutionError(new Error("kaboom"))).toBeNull();
  });
});
