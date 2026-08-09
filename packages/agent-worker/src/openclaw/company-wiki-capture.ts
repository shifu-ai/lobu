const CAPTURE_CAPABILITY_ID = "company_llm_wiki.capture.v1";
const DURABLE_PROCESS_TERMS = [
  "以後",
  "固定",
  "sop",
  "流程",
  "checklist",
  "每次",
  "都要",
];
const COURSE_PM_TERMS = ["確認", "發布", "課程", "line", "faq", "客服", "核准"];

export interface CompanyWikiCaptureMessage {
  role: string;
  content: string;
}

export interface CompanyWikiCaptureInput {
  capabilityIds: string[];
  messages: CompanyWikiCaptureMessage[];
  conversationId?: string;
  runId?: string;
  agentId?: string;
  callTool: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}

export type CompanyWikiCaptureResult =
  | { status: "skipped_no_capability" }
  | { status: "skipped_no_candidate" }
  | { status: "submitted"; reviewItemId?: string; sourceId?: string }
  | { status: "failed"; reason: string };

export async function maybeProposeCompanyWikiCapture(
  input: CompanyWikiCaptureInput
): Promise<CompanyWikiCaptureResult> {
  if (!input.capabilityIds.includes(CAPTURE_CAPABILITY_ID)) {
    return { status: "skipped_no_capability" };
  }

  const conversationText = normalizeWhitespace(
    input.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n")
  );
  if (!isDurableCoursePmKnowledge(conversationText)) {
    return { status: "skipped_no_candidate" };
  }

  const sourceRef = buildSourceRef(input.conversationId, input.runId);
  const rawText = truncate(conversationText, 8_000);
  const title = buildCaptureTitle(input.messages);
  const bodyMd = [
    `# ${title}`,
    "",
    "## Confirmed conversation excerpt",
    "",
    rawText,
  ].join("\n");

  try {
    const result = extractProposalToolResponse(
      await input.callTool("wiki_propose_from_conversation", {
        sourceRef,
        title,
        rawText,
        pageType: "sop",
        proposalTitle: title,
        summary: truncate(rawText, 500),
        bodyMd: truncate(bodyMd, 12_000),
        whyWorthSaving:
          "This conversation contains a repeatable course PM operating rule that should be reviewed for the shared Company Wiki.",
        dedupeKey: `lobu:${input.conversationId ?? "unknown"}:${stableHash(rawText)}:company-wiki-capture:v1`,
        createdByAgentId: input.agentId,
        capturedByAgentId: input.agentId,
      })
    );

    return {
      status: "submitted",
      reviewItemId:
        typeof result.reviewItemId === "string"
          ? result.reviewItemId
          : undefined,
      sourceId:
        typeof result.sourceId === "string" ? result.sourceId : undefined,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isDurableCoursePmKnowledge(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    DURABLE_PROCESS_TERMS.some((term) => lower.includes(term.toLowerCase())) &&
    COURSE_PM_TERMS.some((term) => lower.includes(term.toLowerCase()))
  );
}

function buildSourceRef(conversationId?: string, runId?: string): string {
  const safeConversationId = sanitizeRefPart(conversationId || "unknown");
  const safeRunId = sanitizeRefPart(runId || "turn");
  return `lobu:conversation:${safeConversationId}:${safeRunId}`;
}

function sanitizeRefPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 160);
}

function buildCaptureTitle(messages: CompanyWikiCaptureMessage[]): string {
  const userMessage =
    messages.find((message) => message.role === "user")?.content ??
    messages[0]?.content ??
    "Company Wiki capture";
  const firstLine = normalizeWhitespace(userMessage).split(/[。.!?\n]/)[0];
  return truncate(firstLine || "Company Wiki capture", 120);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function extractProposalToolResponse(result: unknown): {
  reviewItemId?: unknown;
  sourceId?: unknown;
} {
  if (Array.isArray(result)) {
    const text = extractTextContent(result);
    if (text) return extractProposalToolResponse(parseToolText(text));
    return {};
  }
  if (!result || typeof result !== "object") return {};

  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const text = extractTextContent(record.content);
    if (text) return extractProposalToolResponse(parseToolText(text));
  }
  if (typeof record.error === "string") {
    throw new Error(record.error);
  }
  return {
    reviewItemId: record.reviewItemId,
    sourceId: record.sourceId,
  };
}

function extractTextContent(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseToolText(text: string): unknown {
  if (text.startsWith("Error:")) {
    throw new Error(text);
  }
  return JSON.parse(text);
}

function stableHash(value: string): string {
  let hash = 5381;
  for (const char of value) {
    hash = (hash * 33) ^ (char.codePointAt(0) ?? 0);
  }
  return (hash >>> 0).toString(36);
}
