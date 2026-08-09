const RECALL_CAPABILITY_ID = "company_llm_wiki.recall.v1";
const COURSE_PM_RECALL_TERMS = [
  "課程",
  "sop",
  "流程",
  "faq",
  "launch",
  "公告",
  "line",
  "風險",
  "決策",
];

export interface CompanyWikiRecallInput {
  capabilityIds: string[];
  userMessage: string;
  callTool: (
    toolName: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
}

export type CompanyWikiRecallResult =
  | { status: "skipped_no_capability" }
  | { status: "skipped_not_relevant" }
  | { status: "recalled"; contextText: string }
  | { status: "failed"; reason: string };

interface WikiRecallPage {
  title?: unknown;
  pageType?: unknown;
  type?: unknown;
  summary?: unknown;
  bodyMd?: unknown;
}

export async function maybeRecallCompanyWiki(
  input: CompanyWikiRecallInput
): Promise<CompanyWikiRecallResult> {
  if (!input.capabilityIds.includes(RECALL_CAPABILITY_ID)) {
    return { status: "skipped_no_capability" };
  }
  if (!isCoursePmRecallRelevant(input.userMessage)) {
    return { status: "skipped_not_relevant" };
  }

  try {
    const result = await input.callTool("wiki_recall_context", {
      query: input.userMessage,
      limit: 5,
    });
    const pages = extractRecallPages(result);
    const contextText = buildCompanyWikiContextText(pages);
    if (!contextText) return { status: "skipped_not_relevant" };
    return { status: "recalled", contextText };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function isCoursePmRecallRelevant(message: string): boolean {
  const lower = message.toLowerCase();
  return COURSE_PM_RECALL_TERMS.some((term) =>
    lower.includes(term.toLowerCase())
  );
}

function extractRecallPages(result: unknown): WikiRecallPage[] {
  if (Array.isArray(result)) {
    const text = extractTextContent(result);
    return text ? extractRecallPages(parseToolText(text)) : [];
  }
  if (!result || typeof result !== "object") return [];

  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    const text = extractTextContent(record.content);
    return text ? extractRecallPages(parseToolText(text)) : [];
  }
  if (typeof record.error === "string") {
    throw new Error(record.error);
  }
  return Array.isArray(record.pages) ? record.pages : [];
}

function buildCompanyWikiContextText(pages: WikiRecallPage[]): string {
  const lines = [
    "Company Wiki approved context:",
    "Use this as reviewed company knowledge. Do not treat pending review items or raw sources as canonical facts.",
  ];

  for (const page of pages.slice(0, 5)) {
    const title = asString(page.title) || "Untitled";
    const pageType =
      asString(page.pageType) || asString(page.type) || "unknown";
    const summary = asString(page.summary);
    const bodyMd = asString(page.bodyMd);
    lines.push(`- Title: ${title}`);
    lines.push(`  Type: ${pageType}`);
    if (summary) lines.push(`  Summary: ${truncate(summary, 500)}`);
    if (bodyMd) lines.push(`  Excerpt: ${truncate(bodyMd, 800)}`);
    lines.push("  Source: company wiki approved page");
  }

  return truncate(lines.join("\n"), 4_000);
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

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}
