export interface NormalizedTextBlock {
  type: "text";
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function removeControls(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
}

function escapeMarkdownLabel(value: string): string {
  return removeControls(value).replace(/[\\[\]()]/g, (char) => `\\${char}`);
}

function escapeMarkdownUri(value: string): string {
  return encodeURI(removeControls(value).trim()).replace(
    /[()[\]\\]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sanitizeMimeType(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  const sanitized = removeControls(value).replace(/[^A-Za-z0-9.+/_-]/g, "");
  return sanitized || null;
}

function safeDiagnosticToken(value: unknown): string {
  if (!isNonEmptyString(value)) return "unknown";
  const sanitized = removeControls(value).replace(/[^A-Za-z0-9._-]/g, "");
  return sanitized || "unknown";
}

function bytesFromBase64(value: string): number | null {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  try {
    return Buffer.byteLength(compact, "base64");
  } catch {
    return null;
  }
}

function safeResourceText(block: Record<string, unknown>): string {
  const uri = typeof block.uri === "string" ? removeControls(block.uri) : "";
  const name =
    typeof block.name === "string" && block.name.trim()
      ? block.name.trim()
      : uri;

  if (/^https?:\/\//i.test(uri)) {
    return `[resource: ${escapeMarkdownLabel(name || uri)}](${escapeMarkdownUri(uri)})`;
  }

  return `resource: ${uri ? escapeMarkdownLabel(uri) : "unknown"}`;
}

function normalizeImage(block: Record<string, unknown>): NormalizedTextBlock {
  const mimeType = sanitizeMimeType(block.mimeType);
  const data = block.data;
  if (
    !mimeType?.toLowerCase().startsWith("image/") ||
    !isNonEmptyString(data)
  ) {
    return { type: "text", text: "[malformed image result omitted]" };
  }

  const bytes = bytesFromBase64(data);
  if (bytes === null) {
    return { type: "text", text: "[malformed image result omitted]" };
  }

  return {
    type: "text",
    text: `[image result omitted: ${mimeType}, ${bytes} bytes]`,
  };
}

function normalizeAudio(block: Record<string, unknown>): NormalizedTextBlock {
  const mimeType = sanitizeMimeType(block.mimeType);
  const data = block.data;
  if (
    !mimeType?.toLowerCase().startsWith("audio/") ||
    !isNonEmptyString(data)
  ) {
    return { type: "text", text: "[malformed audio result omitted]" };
  }

  const bytes = bytesFromBase64(data);
  if (bytes === null) {
    return { type: "text", text: "[malformed audio result omitted]" };
  }

  return {
    type: "text",
    text: `[audio result omitted: ${mimeType}, ${bytes} bytes]`,
  };
}

export function normalizeMcpResultContent(
  content: unknown
): NormalizedTextBlock[] {
  if (!Array.isArray(content)) return [];

  return content.map((block): NormalizedTextBlock => {
    if (!isRecord(block)) {
      return { type: "text", text: "[malformed MCP result block omitted]" };
    }

    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }

    if (block.type === "resource_link") {
      return { type: "text", text: safeResourceText(block) };
    }

    if (block.type === "image") {
      return normalizeImage(block);
    }

    if (block.type === "audio") {
      return normalizeAudio(block);
    }

    return {
      type: "text",
      text: `[unsupported MCP result block omitted: ${safeDiagnosticToken(block.type)}]`,
    };
  });
}
