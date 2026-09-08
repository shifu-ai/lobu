import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { CodexAppServerClient } from "./codex-client";
import type { CodexCredentialStore } from "./codex-credentials";
import type { SubagentExecutor } from "./dispatcher";
import type { SubagentScope } from "./types";
import { externalCodexAuth, refreshManagedCodexAuth } from "./codex-refresh";
import type { SubagentArtifactStore } from "./artifacts";

export interface CodexRuntimeOptions {
  binary: string;
  stateRoot: string;
  path: string;
  credentials?: CodexCredentialStore;
  artifacts?: SubagentArtifactStore;
}

export async function prepareCodexAccount(options: CodexRuntimeOptions, scope: Pick<SubagentScope, "organizationId" | "userId">) {
  if (!isAbsolute(options.binary) || !isAbsolute(options.stateRoot)) throw new Error("codex_absolute_paths_required");
  const key = createHash("sha256").update(JSON.stringify([scope.organizationId, scope.userId])).digest("hex");
  const accountDir = join(options.stateRoot, "accounts", key);
  await mkdir(accountDir, { recursive: true, mode: 0o700 });
  const home = join(accountDir, "home");
  const codexHome = join(accountDir, "codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  for (const path of [accountDir, home, codexHome]) {
    const rel = relative(await realpath(options.stateRoot), await realpath(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("codex_path_escape");
  }
  return { accountDir, codexHome, env: {
    PATH: options.path, HOME: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, ".config"), LANG: "C.UTF-8",
  } };
}

export const CODEX_PERMISSION_PROFILE = "shifu-subagent";

/** Fresh process configuration; never widen to the legacy workspace-write read policy. */
export function codexSandboxArgs(workspace: string): string[] {
  return ["app-server", "--listen", "stdio://",
    "-c", `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
    "-c", `permissions.${CODEX_PERMISSION_PROFILE}.filesystem={ ":minimal"="read", ${JSON.stringify(workspace)}="write" }`,
    "-c", `permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=false`,
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    "-c", "features.multi_agent=false",
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'shell_environment_policy.inherit="none"',
  ];
}

export function createCodexExecutor(options: CodexRuntimeOptions): SubagentExecutor {
  return async (task, signal) => {
    let credential = await options.credentials?.load(task);
    if (!credential) throw new Error("codex_needs_connection");
    const account = await prepareCodexAccount(options, task);
    const refresh = async () => {
      credential = await options.credentials!.refresh(task, credential!.epoch, credential!.revision,
        authJson => refreshManagedCodexAuth({ binary: options.binary, directory: account.accountDir, path: options.path }, authJson, signal));
      return externalCodexAuth(credential);
    };
    const initialAuth = await refresh();
    // lease 換代的程序不會覆寫前一代程序的工作區。
    const runRoot = join(account.accountDir, "tasks", task.id, String(task.generation));
    const workspace = join(runRoot, "workspace");
    const codexHome = join(runRoot, "codex");
    const home = join(runRoot, "home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const client = new CodexAppServerClient({ binary: options.binary, cwd: workspace, env: { ...account.env, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config") }, args: codexSandboxArgs(workspace),
      refreshAuth: async (params) => {
        if (params.previousAccountId && params.previousAccountId !== initialAuth.chatgptAccountId) throw new Error("codex_needs_connection");
        const auth = await refresh();
        if (auth.chatgptAccountId !== initialAuth.chatgptAccountId) throw new Error("codex_needs_connection");
        return auth;
      },
    });
    const abort = () => client.close();
    let checking = false;
    const connectionWatch = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { if (!(await options.credentials!.isCurrent(task, credential!.epoch))) client.close(); }
      catch { client.close(); }
      finally { checking = false; }
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new Error("codex_execution_aborted");
      await client.initialize();
      if (!(await options.credentials!.isCurrent(task, credential!.epoch))) throw new Error("codex_needs_connection");
      await client.request("account/login/start", { type: "chatgptAuthTokens", ...initialAuth });
      const { thread } = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: workspace, approvalPolicy: "never", permissions: CODEX_PERMISSION_PROFILE, ephemeral: true,
        config: { web_search: "disabled", mcp_servers: {}, "features.multi_agent": false,
          "shell_environment_policy.inherit": "none" },
        developerInstructions: "你是課程 PM 主助理委派的子代理。只處理本次提供的任務與資料；完成後回傳摘要與來源。所有外部寫入、發送與新增委派交回主助理確認。",
      });
      let summary = "";
      const unsubscribe = client.subscribe((message) => {
        if (message.method !== "item/completed" || message.params?.threadId !== thread.id) return;
        const item = message.params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          summary = item.text;
          if (Buffer.byteLength(summary) > 200_000) client.close();
        }
      });
      // 先訂閱才送 turn/start，避免極快完成時漏接終態。
      const completed = client.waitNotification("turn/completed", (params) => params.threadId === thread.id, signal);
      // 防止 start 拒絕時，close 造成未被觀察的 rejection。
      void completed.catch(() => {});
      try {
        await client.request("turn/start", { threadId: thread.id, cwd: workspace, approvalPolicy: "never",
          permissions: CODEX_PERMISSION_PROFILE, input: [{ type: "text", text: task.prompt }] });
        const event = await completed;
        const turn = event.turn as { status?: string } | undefined;
        if (turn?.status !== "completed" || !summary.trim()) throw new Error("codex_turn_failed");
        if (!(await options.credentials!.isCurrent(task, credential!.epoch))) throw new Error("codex_needs_connection");
        await writeFile(join(workspace, "result.md"), summary, { mode: 0o600 });
        await client.stop();
        const artifacts = options.artifacts ? await options.artifacts.collect(task, workspace)
          : [{ path: "result.md", mediaType: "text/markdown", size: Buffer.byteLength(summary) }];
        if (!(await options.credentials!.isCurrent(task, credential!.epoch))) throw new Error("codex_needs_connection");
        return { summary, artifacts };
      } finally { unsubscribe(); }
    } finally {
      signal.removeEventListener("abort", abort);
      clearInterval(connectionWatch);
      await client.stop();
      await rm(codexHome, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  };
}
