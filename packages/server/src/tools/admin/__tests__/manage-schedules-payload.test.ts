import { describe, expect, test } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  coerceSchedulePayload,
  ManageSchedulesSchema,
} from "../manage_schedules";

const validator = TypeCompiler.Compile(ManageSchedulesSchema as any);

const wakeAgentPayload = {
  type: "wake_agent",
  agent_id: "shifu-u-abc123",
  prompt: "排程觸發:提醒使用者喝水",
};

function createArgs(payload: unknown) {
  return {
    action: "create",
    description: "提醒喝水",
    run_at: "2026-07-07T12:05:00Z",
    payload,
  };
}

describe("manage_schedules payload coercion", () => {
  test("object payload passes through unchanged", () => {
    expect(coerceSchedulePayload(wakeAgentPayload)).toEqual(wakeAgentPayload);
    expect(validator.Check(createArgs(wakeAgentPayload))).toBe(true);
  });

  test("JSON-stringified payload is parsed back to an object", () => {
    const coerced = coerceSchedulePayload(JSON.stringify(wakeAgentPayload));
    expect(coerced).toEqual(wakeAgentPayload);
    expect(validator.Check(createArgs(coerced))).toBe(true);
  });

  test("stringified payload without coercion fails the schema (regression guard)", () => {
    expect(validator.Check(createArgs(JSON.stringify(wakeAgentPayload)))).toBe(
      false
    );
  });

  test("non-JSON string returns unchanged so validation reports the real error", () => {
    expect(coerceSchedulePayload("not json")).toBe("not json");
  });

  test("send_notification stringified payload also parses", () => {
    const payload = { type: "send_notification", title: "hi" };
    expect(coerceSchedulePayload(JSON.stringify(payload))).toEqual(payload);
  });
});
