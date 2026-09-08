import { writeFile } from "node:fs/promises";
import {
  completeSimple,
  getModel,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import { getOpenClawSessionContext } from "./openclaw/session-context";
import {
  buildDynamicOpenAIModel,
  buildProviderProxyAuthHeaders,
  DEFAULT_PROVIDER_BASE_URL_ENV,
  PROVIDER_REGISTRY_ALIASES,
  registerDynamicProvider,
  resolveModelRef,
} from "./openclaw/model-resolver";

/** Lobu reasoning child: fresh process/context, no tools, plugins, skills or parent history. */
export async function runLobuSubagent(
  input: { prompt: string; agentId: string; userId: string },
  signal: AbortSignal
): Promise<string> {
  if (
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 65536
  )
    throw new Error("invalid_subagent_input");
  const context = await getOpenClawSessionContext({
    workerToken: process.env.WORKER_TOKEN,
  });
  if (context.agentId !== input.agentId || context.userId !== input.userId)
    throw new Error("subagent_context_mismatch");
  const pc = context.providerConfig;
  for (const [id, config] of Object.entries(pc.configProviders ?? {}))
    registerDynamicProvider(id, config);
  const selected = resolveModelRef("", {
    defaultModel: pc.defaultModel,
    defaultProvider: pc.defaultProvider,
    defaultProviderSlug: pc.defaultProviderSlug,
  });
  const provider =
    PROVIDER_REGISTRY_ALIASES[selected.provider] || selected.provider;
  const baseUrl =
    pc.providerBaseUrlMappings?.[
      DEFAULT_PROVIDER_BASE_URL_ENV[selected.provider] ?? ""
    ];
  const headers = buildProviderProxyAuthHeaders(
    baseUrl,
    process.env.WORKER_TOKEN
  );
  if (
    !baseUrl ||
    !headers ||
    new URL(baseUrl).origin !== new URL(process.env.DISPATCHER_URL!).origin
  )
    throw new Error("subagent_provider_proxy_required");
  const known = getModel(provider as never, selected.modelId as never) as
    | Model<Api>
    | undefined;
  const model = {
    ...(known ??
      buildDynamicOpenAIModel({
        rawProvider: selected.provider,
        registryProvider: provider,
        modelId: selected.modelId,
        providerBaseUrl: baseUrl,
      })),
    baseUrl,
    headers,
    ...(known?.api === "openai-completions" || !known
      ? { compat: { supportsStore: false } }
      : {}),
  } as Model<Api>;
  const result = await completeSimple(
    model,
    {
      systemPrompt:
        "你是課程 PM 主助理委派的獨立子代理。只分析本次提供的材料，回傳有來源的結論、未確定事項及可供主助理採用的產物內容。沒有工具可以執行外部操作；不可宣稱已寄送、寫入或查過未提供的資料。不要新增委派。",
      messages: [
        { role: "user", content: input.prompt, timestamp: Date.now() },
      ],
      tools: [],
    },
    {
      signal,
      maxTokens: 8192,
      apiKey:
        pc.credentialPlaceholders?.[pc.credentialEnvVarName ?? ""] ??
        "lobu-proxy",
    }
  );
  if (
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "toolUse"
  )
    throw new Error("lobu_subagent_failed");
  const summary = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (!summary.trim() || Buffer.byteLength(summary) > 200000)
    throw new Error("lobu_subagent_invalid_result");
  await writeFile("result.md", summary, { mode: 0o600 });
  await writeFile(
    "conversation.jsonl",
    [
      JSON.stringify({ role: "user", content: input.prompt }),
      JSON.stringify({ role: "assistant", content: summary }),
    ].join("\n"),
    { mode: 0o600 }
  );
  return summary;
}

if (require.main === module) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  void (async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 131072) throw new Error("invalid_subagent_input");
      chunks.push(Buffer.from(chunk));
    }
    const summary = await runLobuSubagent(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      controller.signal
    );
    process.stdout.write(
      `${JSON.stringify({ type: "subagent_result", summary })}\n`
    );
  })().catch(() => {
    process.stdout.write(
      `${JSON.stringify({ type: "subagent_error", error: "lobu_subagent_failed" })}\n`
    );
    process.exitCode = 1;
  });
}
