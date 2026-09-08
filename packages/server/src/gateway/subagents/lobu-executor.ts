import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { generateWorkerToken } from "@lobu/core";
import type { ISessionManager } from "../session";
import type { SubagentExecutor } from "./dispatcher";
import type { SubagentArtifactStore } from "./artifacts";

export function createLobuExecutor(options: {
  stateRoot: string;
  dispatcherUrl: string;
  sessionManager: ISessionManager;
  workerEntry?: string;
  artifacts?: SubagentArtifactStore;
}): SubagentExecutor {
  return async (task, signal) => {
    if (!Number.isSafeInteger(task.executionRunId) || task.executionRunId! <= 0 || !isAbsolute(options.stateRoot)) {
      throw new Error("lobu_subagent_invalid_dispatch");
    }
    signal.throwIfAborted();
    const owner = createHash("sha256").update(JSON.stringify([task.organizationId, task.userId])).digest("hex");
    const workspace = join(options.stateRoot, owner, task.id, String(task.generation));
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const rel = relative(await realpath(options.stateRoot), await realpath(workspace));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("lobu_subagent_path_escape");
    const channelId = `api_${task.userId}`;
    await options.sessionManager.setSession({
      conversationId: task.childConversationId, channelId, userId: task.userId,
      threadCreator: task.userId, agentId: task.agentId, organizationId: task.organizationId,
      createdAt: Date.now(), lastActivity: Date.now(), status: "active", workingDirectory: workspace,
      dryRun: true,
    });
    const token = generateWorkerToken(task.userId, task.childConversationId, `subagent-${task.id}`, {
      channelId, agentId: task.agentId, organizationId: task.organizationId,
      platform: "api", sessionKey: task.userId, tokenKind: "run", runId: task.executionRunId,
      messageId: `subagent:${task.id}:${task.generation}`,
      // Deliberately do not inherit the parent's release capabilities.
      releaseState: { status: "enrolled_inactive", environment: task.authorization?.environment ?? "production", reason: "capability_expired" },
    });
    // pi-coding-agent exposes ESM imports only. Use the source entry through
    // Bun, as the existing embedded runtime does for TypeScript workers.
    const entry = options.workerEntry ?? join(dirname(require.resolve("@lobu/worker/package.json")), "src/subagent-worker.ts");
    signal.throwIfAborted();
    const summary = await new Promise<string>((resolve, reject) => {
      const child = spawn(basename(process.execPath).startsWith("bun") ? process.execPath : "bun", [entry], {
        cwd: workspace, detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workspace, LANG: "C.UTF-8",
          DISPATCHER_URL: options.dispatcherUrl, WORKER_TOKEN: token },
      });
      let buffer = ""; let bytes = 0; let result: string | undefined;
      let failed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        failed = true;
        if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }
        killTimer ??= setTimeout(() => {
          if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }
        }, 1000);
        killTimer.unref();
      };
      signal.addEventListener("abort", terminate, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_048_576) { terminate(); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === "subagent_result" && typeof message.summary === "string") result = message.summary;
          } catch { /* Ignore structured logger output and incomplete result lines. */ }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", terminate);
      child.once("error", () => { failed = true; });
      child.once("close", (code) => {
        signal.removeEventListener("abort", terminate);
        if (killTimer) clearTimeout(killTimer);
        if (failed || signal.aborted || code !== 0 || !result?.trim() || Buffer.byteLength(result) > 200000) reject(new Error("lobu_subagent_failed"));
        else resolve(result);
      });
      child.stdin.end(JSON.stringify({ prompt: task.prompt, agentId: task.agentId, userId: task.userId }));
      if (signal.aborted) terminate();
    });
    const artifacts = options.artifacts ? await options.artifacts.collect(task, workspace)
      : [{ path: "result.md", mediaType: "text/markdown", size: Buffer.byteLength(summary) }];
    return { summary, artifacts };
  };
}
