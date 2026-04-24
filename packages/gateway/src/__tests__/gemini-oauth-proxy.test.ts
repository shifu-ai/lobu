import { describe, expect, test } from "bun:test";
import { __testOnly } from "../proxy/gemini-oauth/proxy.js";

describe("Gemini OAuth proxy schema sanitizer", () => {
  test("preserves property names and filters required fields to known properties", () => {
    const sanitized = __testOnly.sanitizeToolSchema({
      type: "object",
      additionalProperties: false,
      required: ["file_path", "content", "mode", 42],
      properties: {
        content: {
          type: "string",
        },
        mode: {
          type: "string",
          const: "append",
          additionalProperties: false,
        },
      },
    });

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        content: {
          type: "string",
        },
        mode: {
          enum: ["append"],
          type: "string",
        },
      },
      required: ["content", "mode"],
    });
  });

  test("drops required fields when schema has no properties map", () => {
    const sanitized = __testOnly.sanitizeToolSchema({
      type: "object",
      required: ["file_path"],
    });

    expect(sanitized).toEqual({
      type: "object",
    });
  });

  test("sanitizes function declaration parameters in request bodies", () => {
    const body: Record<string, unknown> = {
      request: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "write_file",
                parameters: {
                  type: "object",
                  additionalProperties: false,
                  required: ["file_path", "content"],
                  properties: {
                    content: {
                      type: "string",
                      description: "File contents",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    __testOnly.sanitizeRequestBody(body);

    const request = body.request as {
      tools: Array<{
        functionDeclarations: Array<{
          parameters: unknown;
        }>;
      }>;
    };

    expect(request.tools[0]?.functionDeclarations[0]?.parameters).toEqual({
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "File contents",
        },
      },
      required: ["content"],
    });
  });
});
