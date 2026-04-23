import { describe, expect, test } from "bun:test";
import { sanitizeToolSchema } from "../proxy/gemini-oauth/proxy.js";

describe("sanitizeToolSchema", () => {
  test("preserves function parameter properties while stripping unsupported schema keywords", () => {
    const sanitized = sanitizeToolSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
          patternProperties: {},
        },
        mode: {
          const: "read",
        },
      },
      required: ["file_path"],
    });

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        mode: {
          enum: ["read"],
        },
      },
      required: ["file_path"],
    });
  });
});
