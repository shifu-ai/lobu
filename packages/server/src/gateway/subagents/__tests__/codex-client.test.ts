import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../codex-client";
import { CODEX_PERMISSION_PROFILE, codexSandboxArgs, createCodexExecutor, prepareCodexAccount } from "../codex-executor";
import type { SubagentTask } from "../types";
import { cleanupCodexTemporaryHomes } from "../codex-cleanup";

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "shifu-subagent-codex-test-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

test("Codex 帳號目錄按 org/user 隔離，環境不繼承 gateway secrets", async () => {
  const options = { binary: "/usr/bin/false", stateRoot: root, path: "/usr/bin:/bin" };
  const one = await prepareCodexAccount(options, { organizationId: "org", userId: "one" });
  const two = await prepareCodexAccount(options, { organizationId: "org", userId: "two" });
  const otherOrg = await prepareCodexAccount(options, { organizationId: "other-org", userId: "one" });
  expect(new Set([one.codexHome, two.codexHome, otherOrg.codexHome]).size).toBe(3);
  expect(Object.keys(one.env).sort()).toEqual(["CODEX_HOME", "HOME", "LANG", "PATH", "XDG_CONFIG_HOME"]);
  expect(one.env.HOME).not.toBe(process.env.HOME);
});

test("程序提前退出時 RPC 立即失敗", async () => {
  const client = new CodexAppServerClient({ binary: "/usr/bin/false", cwd: root, env: { PATH: "/usr/bin:/bin" } });
  try { await expect(client.initialize()).rejects.toThrow("codex_process_closed"); }
  finally { client.close(); }
});

test("stop 清除同組背景程序，即使 app-server 已回應終止並先退出", async () => {
  const pidFile = join(root, "rpc-descendant.pid");
  const entry = join(root, "rpc-descendant.cjs");
  await writeFile(entry, `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`)}],{stdio:'ignore'});
    child.unref(); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},100);`);
  const client = new CodexAppServerClient({ binary: process.execPath, args: [entry], cwd: root, env: { PATH: "/usr/bin:/bin" } });
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await Bun.sleep(20); }
    }
    expect(pid).toBeGreaterThan(0);
    await client.stop();
    let alive = true;
    const cleanupDeadline = Date.now() + 2500;
    while (alive && Date.now() < cleanupDeadline) {
      try { process.kill(pid!, 0); await Bun.sleep(25); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  } finally {
    await client.stop();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* 已清除。 */ } }
  }
}, 8000);

test("清理 crash 遺留的 Codex 暫存憑證目錄，保留工作產物與近期登入", async () => {
  const account = join(root, "accounts", "f".repeat(64));
  const stale = join(account, "refresh-stale"); const recent = join(account, "refresh-recent");
  const taskRoot = join(account, "tasks", "00000000-0000-4000-8000-000000000001", "1");
  const codex = join(taskRoot, "codex"); const workspace = join(taskRoot, "workspace");
  for (const directory of [stale, recent, codex, workspace]) await mkdir(directory, { recursive: true });
  await writeFile(join(stale, "auth.json"), "dummy-credential");
  await writeFile(join(workspace, "result.md"), "retain artifact");
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const directory of [stale, codex, workspace]) await utimes(directory, old, old);
  expect(await cleanupCodexTemporaryHomes(root)).toBe(2);
  await expect(access(stale)).rejects.toThrow();
  await expect(access(codex)).rejects.toThrow();
  await access(recent);
  expect(await readFile(join(workspace, "result.md"), "utf8")).toBe("retain artifact");
});

const binary = process.env.SUBAGENT_TEST_CODEX_BINARY;
test.skipIf(!binary)("官方 app-server 支援公開文件的 host-managed login，執行程序沒有 refresh token", async () => {
  const options = { binary: binary!, stateRoot: root, path: "/usr/bin:/bin:/opt/homebrew/bin" };
  const account = await prepareCodexAccount(options, { organizationId: "test", userId: "external-auth" });
  const jwt = [Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.invalid", exp: Math.floor(Date.now()/1000)+3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" } })).toString("base64url"), "fixture-signature"].join(".");
  const client = new CodexAppServerClient({ binary: binary!, cwd: root, env: account.env });
  try {
    await client.initialize();
    const login = await client.request<{ type: string }>("account/login/start", { type: "chatgptAuthTokens", accessToken: jwt, chatgptAccountId: "fixture-account" });
    expect(login.type).toBe("chatgptAuthTokens");
    const info = await client.request<{ account: { type: string } | null }>("account/read", { refreshToken: false });
    expect(info.account?.type).toBe("chatgpt");
    const persisted = await readFile(join(account.codexHome, "auth.json"), "utf8").catch(() => "");
    expect(persisted).not.toContain(jwt);
  } finally { await client.stop(); }
}, 30_000);
test.skipIf(!binary)("官方 Codex App Server 在全新隔離帳號完成 handshake 且未登入", async () => {
  const options = { binary: binary!, stateRoot: root, path: "/usr/bin:/bin:/opt/homebrew/bin" };
  const account = await prepareCodexAccount(options, { organizationId: "test", userId: "handshake" });
  const client = new CodexAppServerClient({ binary: binary!, cwd: root, env: account.env });
  try {
    await client.initialize();
    const result = await client.request<{ account: unknown }>("account/read", { refreshToken: false });
    expect(result.account).toBeNull();
  } finally { client.close(); }
}, 30_000);

test.skipIf(!binary)("官方 Codex sandbox 可讀本任務檔案但不能讀另一帳號目錄", async () => {
  const options = { binary: binary!, stateRoot: root, path: "/usr/bin:/bin:/opt/homebrew/bin" };
  const account = await prepareCodexAccount(options, { organizationId: "test", userId: "sandbox" });
  const workspace = join(root, "sandbox-work");
  await mkdir(workspace);
  await writeFile(join(workspace, "input.txt"), "allowed-fixture");
  const otherAccount = await prepareCodexAccount(options, { organizationId: "test", userId: "private" });
  const privateFile = join(otherAccount.codexHome, "private-fixture.txt");
  await writeFile(privateFile, "must-not-read-fixture");
  const client = new CodexAppServerClient({ binary: binary!, cwd: workspace, env: account.env, args: codexSandboxArgs(workspace) });
  try {
    await client.initialize();
    const allowed = await client.request<{ exitCode: number; stdout: string }>("command/exec", {
      command: ["/bin/cat", join(workspace, "input.txt")], cwd: workspace, permissionProfile: CODEX_PERMISSION_PROFILE, timeoutMs: 5000,
    });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toContain("allowed-fixture");
    const denied = await client.request<{ exitCode: number; stdout: string }>("command/exec", {
      command: ["/bin/cat", privateFile], cwd: workspace, permissionProfile: CODEX_PERMISSION_PROFILE, timeoutMs: 5000,
    });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).not.toContain("must-not-read-fixture");
  } finally { client.close(); }
}, 30_000);

test.skipIf(!binary)("未登入的 executor 明確回報需要連接，不能借用主機登入", async () => {
  const execute = createCodexExecutor({ binary: binary!, stateRoot: root, path: "/usr/bin:/bin:/opt/homebrew/bin" });
  const task: SubagentTask = {
    id: "00000000-0000-4000-8000-000000000001", organizationId: "test", userId: "disconnected", agentId: "agent",
    parentConversationId: "parent", parentRunId: "1", childConversationId: "child", backend: "codex",
    title: "測試", prompt: "不應呼叫模型", generation: 1, deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    status: "running", result: null, errorCode: null,
  };
  await expect(execute(task, new AbortController().signal)).rejects.toThrow("codex_needs_connection");
}, 30_000);
