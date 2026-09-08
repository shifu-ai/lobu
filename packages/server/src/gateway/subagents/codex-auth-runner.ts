import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CodexAppServerClient } from "./codex-client";
import { prepareCodexAccount, type CodexRuntimeOptions } from "./codex-executor";
import type { CodexAuthFailureCode, CodexAuthFlow, CodexAuthStore } from "./codex-auth-store";

export async function runCodexLogin(store: CodexAuthStore, flow: CodexAuthFlow, options: CodexRuntimeOptions): Promise<void> {
  const account = await prepareCodexAccount(options, flow);
  const directory = join(account.accountDir, "auth", `${flow.id}-${flow.generation}`);
  const home = join(directory, "home");
  const codexHome = join(directory, "codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const client = new CodexAppServerClient({ binary: options.binary, cwd: home,
    env: { ...account.env, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config") },
    args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"'],
  });
  const signal = AbortSignal.timeout(Math.max(1, Date.parse(flow.expiresAt) - Date.now()));
  const abort = () => client.close();
  signal.addEventListener("abort", abort, { once: true });
  let checking = false;
  let interrupted: CodexAuthFailureCode | undefined;
  const heartbeat = setInterval(async () => {
    if (checking) return;
    checking = true;
    try { if (!(await store.heartbeat(flow))) { interrupted = "codex_auth_lease_lost"; client.close(); } }
    catch { interrupted = "codex_auth_storage_unavailable"; client.close(); }
    finally { checking = false; }
  }, 10_000);
  try {
    await client.initialize();
    const completion = client.waitNotification("account/login/completed", () => true, signal);
    void completion.catch(() => {});
    const login = await client.request<{ loginId: string; userCode: string; verificationUrl: string }>("account/login/start", { type: "chatgptDeviceCode" });
    if (!(await store.publishDeviceCode(flow, login))) throw new Error("codex_auth_lease_lost");
    const event = await completion;
    if (event.loginId !== login.loginId) throw new Error("codex_invalid_login_response");
    if (event.success !== true) throw new Error("codex_auth_provider_rejected");
    const result = await client.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    if (result.account?.type !== "chatgpt") throw new Error("codex_login_failed");
    const path = join(codexHome, "auth.json");
    if ((await stat(path)).size > 65536) throw new Error("codex_invalid_auth");
    if (!(await store.complete(flow, await readFile(path, "utf8")))) throw new Error("codex_auth_lease_lost");
  } catch (error) {
    // Persist only our closed diagnostic codes; never provider error text or credentials.
    const allowed: CodexAuthFailureCode[] = ["codex_auth_provider_rejected", "codex_auth_lease_lost",
      "codex_rpc_timeout", "codex_rpc_rejected", "codex_process_closed", "codex_invalid_login_response", "codex_invalid_auth"];
    const message = error instanceof Error ? error.message : "";
    const code = interrupted ?? (signal.aborted ? "codex_auth_expired"
      : allowed.find(value => value === message) ?? "codex_login_failed");
    await store.fail(flow, code);
  } finally {
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
