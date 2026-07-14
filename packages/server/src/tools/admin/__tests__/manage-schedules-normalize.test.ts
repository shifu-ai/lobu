import { describe, expect, test } from "bun:test";
import {
  ManageSchedulesSchema,
  normalizeCreateArgs,
} from "../manage_schedules";

describe("ManageSchedulesSchema is MCP-projection-safe", () => {
  test("root schema is a plain object with no union keywords", () => {
    const schema = ManageSchedulesSchema as unknown as Record<string, unknown>;
    expect(schema.type).toBe("object");
    for (const keyword of ["anyOf", "oneOf", "allOf", "not", "if"]) {
      expect(Object.hasOwn(schema, keyword)).toBe(false);
    }
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const [name, prop] of Object.entries(properties)) {
      for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        if (Object.hasOwn(prop, keyword)) {
          throw new Error(`property ${name} uses union keyword ${keyword}`);
        }
      }
    }
  });
});

describe("normalizeCreateArgs", () => {
  test("canonical payload passes through unchanged", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "提醒喝水",
      run_at: "2026-07-08T01:00:00Z",
      payload: { type: "wake_agent", agent_id: "shifu-u-abc", prompt: "喝水" },
    });
    expect(args.payload).toEqual({
      type: "wake_agent",
      agent_id: "shifu-u-abc",
      prompt: "喝水",
    });
  });

  test("strips internal trusted wake provenance while preserving benign extra fields", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "ordinary wake",
      run_at: "2026-08-01T00:00:00Z",
      payload: {
        type: "wake_agent",
        agent_id: "shifu-u-abc",
        prompt: "hello",
        custom_metadata: { tolerated: true },
        trustedCoursePreference: "course-a",
        trustedCourseWake: { source: "calendar_scheduled_wake" },
        trustedCourseScope: { courseKey: "course-a" },
        __trustedCourseWakeProvenance: "internal",
      },
    });

    expect(args.payload).toEqual({
      type: "wake_agent",
      agent_id: "shifu-u-abc",
      prompt: "hello",
      custom_metadata: { tolerated: true },
      trustedCoursePreference: "course-a",
    });
  });

  test("flattened wake_agent fields are lifted into payload (observed model shape)", () => {
    // Exactly what the production agent sent on 2026-07-07: no payload,
    // action_type + agent_id at the top level.
    const args = normalizeCreateArgs({
      action: "create",
      description: "提醒喝水",
      run_at: "2026-07-08T01:00:00Z",
      action_type: "wake_agent",
      agent_id: "shifu-u-302b8bcc3af1",
      prompt: "提醒使用者喝水",
    });
    expect(args.payload).toEqual({
      type: "wake_agent",
      agent_id: "shifu-u-302b8bcc3af1",
      prompt: "提醒使用者喝水",
    });
    expect(args.agent_id).toBeUndefined();
    expect(args.action_type).toBeUndefined();
  });

  test("stringified payload with action_type alias inside is parsed and typed", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "提醒喝水",
      run_at: "2026-07-08T01:00:00Z",
      payload: JSON.stringify({
        action_type: "send_notification",
        title: "💧 喝水時間",
        body: "記得補充水分",
      }),
    });
    expect(args.payload).toEqual({
      type: "send_notification",
      title: "💧 喝水時間",
      body: "記得補充水分",
    });
  });

  test("flattened notification fields infer send_notification type", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "通知",
      run_at: "2026-07-08T01:00:00Z",
      title: "hi",
      body: "there",
    });
    expect(args.payload).toEqual({
      type: "send_notification",
      title: "hi",
      body: "there",
    });
  });

  test("missing run_at with cron derives the first firing from the cron", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "daily",
      cron: "0 9 * * *",
      payload: { type: "wake_agent", agent_id: "a", prompt: "p" },
    });
    expect(typeof args.run_at).toBe("string");
    expect(Number.isNaN(new Date(args.run_at as string).getTime())).toBe(false);
  });

  test("prompt alone infers wake_agent", () => {
    const args = normalizeCreateArgs({
      action: "create",
      description: "x",
      run_at: "2026-07-08T01:00:00Z",
      agent_id: "shifu-u-abc",
      prompt: "hello",
    });
    expect((args.payload as Record<string, unknown>).type).toBe("wake_agent");
  });
});
