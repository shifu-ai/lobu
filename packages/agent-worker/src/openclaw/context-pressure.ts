import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ContextPressureClassification =
  | "fits"
  | "needs_spill"
  | "needs_fork"
  | "unrecoverable";

export interface ContextArtifactDescriptor {
  artifactId: string;
  kind: "user_input" | "tool_result" | "attachment" | "transcript" | "document";
  source: "line" | "mcp" | "file" | "internal";
  title?: string;
  byteSize: number;
  estimatedTokens: number;
  sha256: string;
  chunkCount: number;
  outline: string[];
  preview: string;
  createdByRunId: string;
  path: string;
}

export interface PreparedPrompt {
  classification: ContextPressureClassification;
  promptText: string;
  artifacts: ContextArtifactDescriptor[];
}

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_CHUNK_CHARS = 12_000;
const INLINE_PROMPT_TOKEN_FLOOR = 8_000;

export function isProviderPromptTooLongError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes("prompt is too long") ||
    normalized.includes("context length") ||
    normalized.includes("maximum context") ||
    normalized.includes("tokens >")
  );
}

export function userFacingContextPressureMessage(): string {
  return "這份內容比目前可一次處理的範圍還大。我已先保留可處理的資料，但這輪無法完整完成。你可以指定要先看哪一段，我會接著處理。";
}

export function estimateContextTokens(
  text: string,
  imageCount: number
): number {
  return (
    Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE) +
    Math.max(0, imageCount) * 1200
  );
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 700
    ? `${normalized.slice(0, 700)}...`
    : normalized;
}

function outlineText(text: string): string[] {
  const headings = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^(#{1,6}\s+|[一二三四五六七八九十]+[、.]|\d+[.)、])/.test(line)
    )
    .slice(0, 12);
  return headings.length > 0 ? headings : ["Large user-provided content"];
}

async function writeArtifact(params: {
  workspaceDir: string;
  text: string;
  kind: ContextArtifactDescriptor["kind"];
  source: ContextArtifactDescriptor["source"];
  runId: string;
  title?: string;
}): Promise<ContextArtifactDescriptor> {
  const artifactsDir = path.join(params.workspaceDir, ".lobu", "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  const artifactId = `ctx_art_${randomUUID().replace(/-/g, "")}`;
  const artifactPath = path.join(artifactsDir, `${artifactId}.txt`);
  const sha256 = createHash("sha256").update(params.text).digest("hex");
  await fs.writeFile(artifactPath, params.text, "utf-8");

  return {
    artifactId,
    kind: params.kind,
    source: params.source,
    title: params.title,
    byteSize: Buffer.byteLength(params.text, "utf-8"),
    estimatedTokens: estimateContextTokens(params.text, 0),
    sha256,
    chunkCount: Math.max(
      1,
      Math.ceil(params.text.length / DEFAULT_CHUNK_CHARS)
    ),
    outline: outlineText(params.text),
    preview: previewText(params.text),
    createdByRunId: params.runId,
    path: artifactPath,
  };
}

export function renderArtifactDescriptor(
  artifact: ContextArtifactDescriptor
): string {
  return [
    `Large content was stored as artifact ${artifact.artifactId}.`,
    "Use artifact_read with chunk selectors to inspect it. Do not assume unseen chunks.",
    `Kind: ${artifact.kind}`,
    `Source: ${artifact.source}`,
    `Byte size: ${artifact.byteSize}`,
    `Estimated tokens: ${artifact.estimatedTokens}`,
    `Chunk count: ${artifact.chunkCount}`,
    "Outline:",
    ...artifact.outline.map((item, index) => `${index + 1}. ${item}`),
    "Preview:",
    artifact.preview,
  ].join("\n");
}

export async function prepareUserPromptForContext(params: {
  workspaceDir: string;
  promptText: string;
  source: ContextArtifactDescriptor["source"];
  runId: string;
  effectiveCapTokens: number;
}): Promise<PreparedPrompt> {
  const tokenEstimate = estimateContextTokens(params.promptText, 0);
  const inlineCap = Math.max(
    INLINE_PROMPT_TOKEN_FLOOR,
    Math.floor(params.effectiveCapTokens * 0.65)
  );
  if (tokenEstimate <= inlineCap) {
    return {
      classification: "fits",
      promptText: params.promptText,
      artifacts: [],
    };
  }

  const artifact = await writeArtifact({
    workspaceDir: params.workspaceDir,
    text: params.promptText,
    kind: "user_input",
    source: params.source,
    runId: params.runId,
    title: "Oversized incoming user message",
  });

  return {
    classification: "needs_spill",
    promptText: renderArtifactDescriptor(artifact),
    artifacts: [artifact],
  };
}

export async function normalizeToolTextForContext(params: {
  workspaceDir?: string;
  text: string;
  source: "mcp" | "internal";
  runId: string;
  toolLabel: string;
  inlineTokenCap?: number;
  descriptorPrefix?: string;
}): Promise<string> {
  const inlineTokenCap = params.inlineTokenCap ?? 8_000;
  if (
    estimateContextTokens(params.text, 0) <= inlineTokenCap ||
    !params.workspaceDir
  ) {
    return params.text;
  }

  const artifact = await writeArtifact({
    workspaceDir: params.workspaceDir,
    text: params.text,
    kind: "tool_result",
    source: params.source,
    runId: params.runId,
    title: `Large tool result from ${params.toolLabel}`,
  });

  const descriptor = renderArtifactDescriptor(artifact);
  return params.descriptorPrefix
    ? `${params.descriptorPrefix}\n${descriptor}`
    : descriptor;
}

export async function readContextArtifactChunk(params: {
  workspaceDir: string;
  artifactId: string;
  chunkIndex: number;
  chunkChars?: number;
}): Promise<{
  artifactId: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
}> {
  if (!/^ctx_art_[a-f0-9]+$/.test(params.artifactId)) {
    throw new Error("Invalid artifact id");
  }

  const chunkChars = params.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const artifactPath = path.join(
    params.workspaceDir,
    ".lobu",
    "artifacts",
    `${params.artifactId}.txt`
  );
  const text = await fs.readFile(artifactPath, "utf-8");
  const totalChunks = Math.max(1, Math.ceil(text.length / chunkChars));

  if (
    !Number.isInteger(params.chunkIndex) ||
    params.chunkIndex < 0 ||
    params.chunkIndex >= totalChunks
  ) {
    throw new Error(`chunkIndex must be between 0 and ${totalChunks - 1}`);
  }

  const start = params.chunkIndex * chunkChars;
  return {
    artifactId: params.artifactId,
    chunkIndex: params.chunkIndex,
    totalChunks,
    text: text.slice(start, start + chunkChars),
  };
}
