import { describe, expect, test } from "bun:test";
import {
  summarizeInputSchemaForModel,
  unknownTopLevelKeys,
} from "../summarize-input-schema";

describe("summarizeInputSchemaForModel", () => {
  test("covers scalar, array, nested object and union types", () => {
    const summary = summarizeInputSchemaForModel({
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", description: "What to do" },
        count: { type: "integer" },
        flag: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        payload: {
          type: "object",
          properties: { deep: { type: "string" } },
        },
        mixed: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });

    expect(summary).toBeDefined();
    const byName = Object.fromEntries(summary!.fields.map((f) => [f.name, f]));
    expect(byName.action).toMatchObject({
      type: "string",
      required: true,
      description: "What to do",
    });
    expect(byName.count!.type).toBe("integer");
    expect(byName.flag!.type).toBe("boolean");
    expect(byName.tags!.type).toBe("array");
    // 巢狀 object 只出第一層，不遞迴展開
    expect(byName.payload!.type).toBe("object");
    expect(byName.payload).not.toHaveProperty("fields");
    expect(byName.mixed!.type).toBe("string|number");
    expect(summary!.required).toEqual(["action"]);
    expect(summary!.truncated).toBe(false);
  });

  test("carries enum and const values, capped at 12", () => {
    const summary = summarizeInputSchemaForModel({
      type: "object",
      properties: {
        mode: { enum: ["a", "b", "c"] },
        kind: { const: "wake_agent" },
        many: { enum: Array.from({ length: 20 }, (_, i) => `v${i}`) },
      },
    });

    expect(summary!.fields.find((f) => f.name === "mode")!.enum).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(summary!.fields.find((f) => f.name === "kind")!.enum).toEqual([
      "wake_agent",
    ]);
    expect(summary!.fields.find((f) => f.name === "many")!.enum).toHaveLength(
      12
    );
  });

  test("truncates to the byte cap, keeping required fields first", () => {
    const properties: Record<string, unknown> = {
      keepMe: { type: "string", description: "required field" },
    };
    for (let i = 0; i < 200; i += 1) {
      properties[`filler${i}`] = {
        type: "string",
        description: "x".repeat(180),
      };
    }

    const summary = summarizeInputSchemaForModel({
      type: "object",
      required: ["keepMe"],
      properties,
    });

    expect(summary!.truncated).toBe(true);
    expect(summary!.fields[0]!.name).toBe("keepMe");
    expect(summary!.fields.length).toBeLessThan(201);
    // Verify actual serialized array size (including JSON overhead) respects the cap.
    const serializedSize = Buffer.byteLength(
      JSON.stringify(summary!.fields),
      "utf8"
    );
    expect(serializedSize).toBeLessThanOrEqual(2560);
  });

  test("keeps `id` inside the digest for a schema shaped like ManageSchedulesSchema (agent-stack #86)", () => {
    // Regression pin for MAX_SUMMARY_BYTES. The real ManageSchedulesSchema
    // (packages/server) measured 2276 bytes across 25 fields, with `id`
    // declared 24th of 25 — second to last. This fixture is not imported
    // from packages/server (agent-worker tests must not depend on server
    // package internals); it inlines a same-shaped schema instead: ~25
    // optional string properties, most with realistic 40-150 char
    // descriptions, `id` late in declaration order.
    //
    // The previous truncation test above only proves the byte cap is
    // respected — its 200 synthetic filler fields all have the same name
    // length and description length, so it can't tell the difference
    // between MAX_SUMMARY_BYTES = 2048 and 2560. This test can: at 2048,
    // truncation drops the declaration-order tail before it reaches `id`,
    // and issue #86 (the model retrying `schedule_id` forever because it
    // never sees the digest naming the field `id`) silently stops being
    // fixed. Do NOT "restore" 2048 here to match older docs — 2560 is the
    // value that keeps `id` inside the truncation window for this schema.
    const fieldDescriptions: Record<string, string | undefined> = {
      action:
        "Action to perform on the scheduled job: create, update, cancel, or pause.",
      title: "Human-readable title shown in the schedule list.",
      cron: undefined,
      timezone: "IANA timezone used to interpret the cron expression above.",
      notes: undefined,
      channel: "Channel the schedule should notify on completion or failure.",
      repeat: undefined,
      maxRetries: "Maximum retries allowed before the schedule is paused.",
      retryDelay: undefined,
      agentId: "Identifier of the agent that owns and runs this schedule.",
      conversationId: undefined,
      payload: "Payload template merged into the job at execution time.",
      priority: undefined,
      enabled: "Whether the schedule is currently enabled or paused.",
      tags: undefined,
      deadline:
        "Deadline after which a missed run is skipped instead of run late.",
      catchUp: undefined,
      source: "Source that originally created this schedule (UI, MCP, import).",
      lastStatus: undefined,
      lastRunAt: undefined,
      nextRunAt: "Timestamp of the next scheduled execution, if computable.",
      version: undefined,
      category: "Free-form category label used for dashboard grouping.",
      // `id` at position 24 of 25 — this is the field #86 needs the model
      // to see instead of the `schedule_id` name it kept guessing.
      id: "Unique identifier of the schedule to create, update, or cancel.",
      reason: "Reason supplied by the caller for this schedule mutation.",
    };
    const propertyNames = Object.keys(fieldDescriptions);
    expect(propertyNames).toHaveLength(25);
    expect(propertyNames[23]).toBe("id");

    const properties: Record<string, unknown> = {};
    for (const name of propertyNames) {
      const description = fieldDescriptions[name];
      properties[name] =
        description === undefined
          ? { type: "string" }
          : { type: "string", description };
    }

    const summary = summarizeInputSchemaForModel({
      type: "object",
      required: ["action"],
      properties,
    });

    expect(summary!.truncated).toBe(false);
    expect(summary!.fields.some((f) => f.name === "id")).toBe(true);
    const serializedSize = Buffer.byteLength(
      JSON.stringify(summary!.fields),
      "utf8"
    );
    // Real schema measured 2276 bytes; this fixture lands close to that.
    // Assert well under the 2560 cap so there's real headroom, not a
    // coincidental pass at the boundary.
    expect(serializedSize).toBeLessThan(2500);
  });

  test("truncates descriptions to 200 chars", () => {
    const summary = summarizeInputSchemaForModel({
      type: "object",
      properties: { a: { type: "string", description: "y".repeat(500) } },
    });
    expect(summary!.fields[0]!.description!.length).toBeLessThanOrEqual(200);
  });

  test("treats every field as optional when required[] is absent", () => {
    const summary = summarizeInputSchemaForModel({
      type: "object",
      properties: { a: { type: "string" } },
    });
    expect(summary!.required).toEqual([]);
    expect(summary!.fields[0]!.required).toBe(false);
  });

  test("returns undefined for a missing or non-object schema", () => {
    expect(summarizeInputSchemaForModel(undefined)).toBeUndefined();
    expect(summarizeInputSchemaForModel("nope")).toBeUndefined();
    expect(summarizeInputSchemaForModel({ type: "object" })).toBeUndefined();
  });

  test("lists keys the caller sent that the schema never declared", () => {
    const schema = {
      type: "object",
      properties: { action: { type: "string" }, id: { type: "string" } },
    };
    expect(
      unknownTopLevelKeys(schema, { action: "cancel", schedule_id: "abc" })
    ).toEqual(["schedule_id"]);
    expect(
      unknownTopLevelKeys(schema, { action: "cancel", id: "abc" })
    ).toEqual([]);

    const summary = summarizeInputSchemaForModel(schema, {
      argsSent: { action: "cancel", schedule_id: "abc" },
    });
    expect(summary!.unknownKeysSent).toEqual(["schedule_id"]);
  });
});
