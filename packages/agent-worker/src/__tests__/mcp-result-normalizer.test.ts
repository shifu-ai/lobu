import { describe, expect, test } from "bun:test";
import { normalizeMcpResultContent } from "../openclaw/mcp-result-normalizer";

describe("normalizeMcpResultContent", () => {
  test("keeps text and projects resource links", () => {
    expect(
      normalizeMcpResultContent([
        { type: "text", text: "hello" },
        { type: "resource_link", uri: "https://example.com/a", name: "doc" },
      ])
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "[resource: doc](https://example.com/a)" },
    ]);
  });

  test("turns images, audio, and non-http resources into safe text", () => {
    expect(
      normalizeMcpResultContent([
        { type: "image", mimeType: "image/png", data: "YWJjZA==" },
        { type: "audio", mimeType: "audio/wav", data: "YWJj" },
        { type: "resource_link", uri: "file:///tmp/secret.txt" },
      ])
    ).toEqual([
      { type: "text", text: "[image result omitted: image/png, 4 bytes]" },
      { type: "text", text: "[audio result omitted: audio/wav, 3 bytes]" },
      { type: "text", text: "resource: file:///tmp/secret.txt" },
    ]);
  });

  test("malformed and unknown blocks become diagnostics without throwing", () => {
    expect(
      normalizeMcpResultContent([
        { type: "image", data: 123 },
        { type: "audio", mimeType: 123 },
        { type: "custom", value: true },
        null,
      ])
    ).toEqual([
      { type: "text", text: "[malformed image result omitted]" },
      { type: "text", text: "[malformed audio result omitted]" },
      { type: "text", text: "[unsupported MCP result block omitted: custom]" },
      { type: "text", text: "[malformed MCP result block omitted]" },
    ]);
  });

  test("escapes malicious resource labels and uri delimiters", () => {
    expect(
      normalizeMcpResultContent([
        {
          type: "resource_link",
          name: "doc](https://evil)",
          uri: "https://example.com/a) \n[evil](https://evil)",
        },
      ])
    ).toEqual([
      {
        type: "text",
        text: "[resource: doc\\]\\(https://evil\\)](https://example.com/a%29%20%5Bevil%5D%28https://evil%29)",
      },
    ]);
  });

  test("escapes non-http resource fallback text", () => {
    expect(
      normalizeMcpResultContent([
        {
          type: "resource_link",
          uri: "file:///tmp/[click](https://evil.test)",
        },
      ])
    ).toEqual([
      {
        type: "text",
        text: "resource: file:///tmp/\\[click\\]\\(https://evil.test\\)",
      },
    ]);
  });

  test("sanitizes mime types before diagnostics", () => {
    expect(
      normalizeMcpResultContent([
        {
          type: "image",
          mimeType: "image/png]\n[evil](x)",
          data: "YWJj",
        },
        {
          type: "audio",
          mimeType: "audio/mpeg\r\n![x](y)",
          data: "YWJj",
        },
      ])
    ).toEqual([
      {
        type: "text",
        text: "[image result omitted: image/pngevilx, 3 bytes]",
      },
      {
        type: "text",
        text: "[audio result omitted: audio/mpegxy, 3 bytes]",
      },
    ]);
  });

  test("sanitizes unsupported block type diagnostics", () => {
    expect(
      normalizeMcpResultContent([
        { type: "custom]\n[evil](https://evil)", value: true },
      ])
    ).toEqual([
      {
        type: "text",
        text: "[unsupported MCP result block omitted: customevilhttpsevil]",
      },
    ]);
  });
});
