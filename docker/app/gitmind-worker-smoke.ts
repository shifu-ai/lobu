import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeSandboxStrategy } from "./packages/agent-worker/src/embedded/exec-sandbox";
import { createEmbeddedBashOps } from "./packages/agent-worker/src/embedded/just-bash-bootstrap";

// This file is copied to /app so imports resolve exactly as in the worker.
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitmind-worker-")));
try {
  delete process.env.GITMIND_TOKEN;
  delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
  process.env.LOBU_EXEC_SANDBOX = "bwrap";
  assert.equal(probeSandboxStrategy().kind, "bwrap");
  const ops = await createEmbeddedBashOps({ workspaceDir: workspace });
  const chunks: string[] = [];
  const result = await ops.exec("gitmind doctor --json", "/", {
    onData: (chunk) => chunks.push(chunk.toString()),
    timeout: 10,
  });
  assert.equal(result.exitCode, 1);
  const status = JSON.parse(chunks.join(""));
  assert.equal(status.auth.available, false);
  assert.equal(status.endpoint.reachable, false);
  assert.ok(status.error.startsWith("missing auth"));
  console.log(JSON.stringify({ installed: true, sandbox: "bwrap", authenticated: false }));
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
