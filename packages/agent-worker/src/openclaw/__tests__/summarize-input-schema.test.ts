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
    const byName = Object.fromEntries(
      summary!.fields.map((f) => [f.name, f])
    );
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
    const serializedSize = Buffer.byteLength(JSON.stringify(summary!.fields), "utf8");
    expect(serializedSize).toBeLessThanOrEqual(2560);
  });

  test("truncates descriptions to 200 chars", () => {
    const summary = summarizeInputSchemaForModel({
      type: "object",
      properties: { a: { type: "string", description: "y".repeat(500) } },
    });
    expect(summary!.fields[0]!.description!.length).toBeLessThanOrEqual(201);
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
    expect(unknownTopLevelKeys(schema, { action: "cancel", id: "abc" })).toEqual(
      []
    );

    const summary = summarizeInputSchemaForModel(schema, {
      argsSent: { action: "cancel", schedule_id: "abc" },
    });
    expect(summary!.unknownKeysSent).toEqual(["schedule_id"]);
  });
});
