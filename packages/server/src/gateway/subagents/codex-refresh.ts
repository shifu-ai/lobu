import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CodexAppServerClient } from "./codex-client";
import type { CodexCredential } from "./codex-credentials";

export function externalCodexAuth(credential: CodexCredential) {
  const data = JSON.parse(credential.authJson);
  if (typeof data.tokens?.access_token !== "string" || !data.tokens.access_token ||
      typeof data.tokens?.account_id !== "string" || !data.tokens.account_id) throw new Error("codex_needs_connection");
  return { accessToken: data.tokens.access_token, chatgptAccountId: data.tokens.account_id };
}

/** Only this short-lived official managed-auth process receives refresh credentials. */
export async function refreshManagedCodexAuth(options: { binary: string; directory: string; path: string }, authJson: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const root = await mkdtemp(join(options.directory, "refresh-"));
  let client: CodexAppServerClient | undefined;
  const abort = () => client?.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const home = join(root, "home"); const codexHome = join(root, "codex");
    await mkdir(home, { mode: 0o700 }); await mkdir(codexHome, { mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
    signal.throwIfAborted();
    client = new CodexAppServerClient({ binary: options.binary, cwd: home,
      env: { PATH: options.path, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config") },
      args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"'],
    });
    await client.initialize();
    const result = await client.request<{ account: { type: string } | null }>("account/read", { refreshToken: true });
    if (result.account?.type !== "chatgpt") throw new Error("codex_needs_connection");
    const file = join(codexHome, "auth.json");
    if ((await stat(file)).size > 65536) throw new Error("codex_invalid_auth");
    signal.throwIfAborted();
    return await readFile(file, "utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    await client?.stop();
    await rm(root, { recursive: true, force: true });
  }
}
