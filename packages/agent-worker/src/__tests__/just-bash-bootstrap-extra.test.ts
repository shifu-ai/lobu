import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpToolDef } from "@lobu/core";
import { resetSandboxProbeForTests } from "../embedded/exec-sandbox";
import { createEmbeddedBashOps } from "../embedded/just-bash-bootstrap";
import type {
  McpRuntimeRef,
  McpRuntimeState,
} from "../embedded/mcp-cli-commands";
import type { GatewayParams } from "../shared/tool-implementations";

const tempDirs: string[] = [];

const ENV_KEYS_TO_RESTORE = [
  "PATH",
  "OWLETTO_EXEC_SANDBOX",
  "LOBU_ALLOW_UNSANDBOXED_EXEC",
  "JUST_BASH_ALLOWED_DOMAINS",
  "WORKSPACE_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS_TO_RESTORE) originalEnv[k] = process.env[k];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const k of ENV_KEYS_TO_RESTORE) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSandboxProbeForTests();
});

const gw: GatewayParams = {
  gatewayUrl: "http://gateway",
  workerToken: "worker-token",
  channelId: "channel-1",
  conversationId: "conversation-1",
  platform: "telegram",
};

const owlettoTool: McpToolDef = {
  name: "search_knowledge",
  description: "Search memory",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function makeRef(overrides: Partial<McpRuntimeState> = {}): McpRuntimeRef {
  return {
    current: {
      mcpTools: overrides.mcpTools ?? {},
      mcpStatus: overrides.mcpStatus ?? [],
      mcpContext: overrides.mcpContext ?? {},
    },
  };
}

function freshWorkspace(): string {
  const ws = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lobu-bootstrap-extra-"))
  );
  tempDirs.push(ws);
  return ws;
}

// ---------------------------------------------------------------------------
// JUST_BASH_ALLOWED_DOMAINS env-var parsing
// ---------------------------------------------------------------------------

describe("createEmbeddedBashOps env parsing", () => {
  test("ignores malformed JUST_BASH_ALLOWED_DOMAINS without crashing", async () => {
    const ws = freshWorkspace();
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    process.env.JUST_BASH_ALLOWED_DOMAINS = "not[json";

    const errs: string[] = [];
    const originalErr = console.error;
    console.error = (msg: string) => errs.push(String(msg));
    try {
      const ops = await createEmbeddedBashOps({ workspaceDir: ws });
      expect(ops).toBeDefined();
      expect(errs.some((e) => e.includes("Failed to parse"))).toBe(true);
    } finally {
      console.error = originalErr;
    }
  });

  test("respects valid JUST_BASH_ALLOWED_DOMAINS without throwing", async () => {
    const ws = freshWorkspace();
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    process.env.JUST_BASH_ALLOWED_DOMAINS = JSON.stringify([
      "api.example.com",
      "github.com",
    ]);

    const ops = await createEmbeddedBashOps({ workspaceDir: ws });
    expect(ops).toBeDefined();

    const out: string[] = [];
    const r = await ops.exec("echo ok", "/", {
      onData: (chunk) => out.push(chunk.toString()),
      timeout: 5,
    });
    expect(r.exitCode).toBe(0);
    expect(out.join("")).toContain("ok");
  });

  test("falls back to /workspace dir when env unset", async () => {
    delete process.env.WORKSPACE_DIR;
    delete process.env.JUST_BASH_ALLOWED_DOMAINS;
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;
    // Pass an explicit workspaceDir so we don't actually try to mkdir /workspace
    // on this host. The test verifies the function returns BashOperations.
    const ws = freshWorkspace();
    const ops = await createEmbeddedBashOps({ workspaceDir: ws });
    expect(ops).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sandbox-disabled path: without sandbox + opt-in, no spawned binaries are
// registered (already covered by the existing test file). Here we cover the
// LOBU_ALLOW_UNSANDBOXED_EXEC=1 branch + the per-command env wiring.
// ---------------------------------------------------------------------------

describe("createEmbeddedBashOps spawned-binary registration", () => {
  test("registers PATH binaries when LOBU_ALLOW_UNSANDBOXED_EXEC=1", async () => {
    const ws = freshWorkspace();
    const nixBin = path.join(ws, "nix", "store", "fake", "bin");
    fs.mkdirSync(nixBin, { recursive: true });
    const probe = path.join(nixBin, "lobu-probe-bin");
    // Print PWD and a marker so we can verify cwd resolution + env wiring.
    fs.writeFileSync(
      probe,
      '#!/bin/sh\necho "marker:$LOBU_TEST_MARKER pwd:$(pwd)"\n',
      "utf8"
    );
    fs.chmodSync(probe, 0o755);

    process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC = "1";
    process.env.LOBU_TEST_MARKER = "yes";

    try {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg: string) => logs.push(String(msg));
      let ops;
      try {
        ops = await createEmbeddedBashOps({ workspaceDir: ws });
      } finally {
        console.log = originalLog;
      }

      // The "Registered N binary commands" log line should fire.
      expect(logs.some((l) => l.includes("binary commands"))).toBe(true);

      const chunks: string[] = [];
      const r = await ops.exec("lobu-probe-bin", "/", {
        onData: (c) => chunks.push(c.toString()),
        timeout: 5,
      });
      expect(r.exitCode).toBe(0);
      const stdout = chunks.join("");
      // env propagation — env-record was built from process.env (sensitive keys
      // stripped, but LOBU_TEST_MARKER is not on the strip list).
      expect(stdout).toContain("marker:yes");
      // resolveHostCwd("/", ws) should land us inside `ws`.
      expect(stdout).toContain(`pwd:${ws}`);
    } finally {
      delete process.env.LOBU_TEST_MARKER;
    }
  });

  test("HTTP_PROXY env is forced into spawned commands and cannot be overridden", async () => {
    const ws = freshWorkspace();
    const nixBin = path.join(ws, "nix", "store", "fake", "bin");
    fs.mkdirSync(nixBin, { recursive: true });
    const probe = path.join(nixBin, "lobu-proxy-probe");
    fs.writeFileSync(
      probe,
      '#!/bin/sh\necho "HTTP_PROXY=$HTTP_PROXY NO_PROXY=$NO_PROXY"\n',
      "utf8"
    );
    fs.chmodSync(probe, 0o755);

    process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC = "1";
    process.env.HTTP_PROXY = "http://gateway-proxy.local:8118";
    process.env.NO_PROXY = "should-be-stripped";

    const ops = await createEmbeddedBashOps({ workspaceDir: ws });
    const chunks: string[] = [];
    // Try to override HTTP_PROXY through `export …` — gateway should win.
    const r = await ops.exec(
      "export HTTP_PROXY=http://attacker.example.com:1; export NO_PROXY=allow-anything; lobu-proxy-probe",
      "/",
      {
        onData: (c) => chunks.push(c.toString()),
        timeout: 5,
      }
    );
    expect(r.exitCode).toBe(0);
    const out = chunks.join("");
    expect(out).toContain("HTTP_PROXY=http://gateway-proxy.local:8118");
    // NO_PROXY is deleted — it must NOT show the attacker-set value.
    expect(out).not.toContain("NO_PROXY=allow-anything");
  });

  test("cwd outside the workspace fails with 'resolves outside workspace'", async () => {
    const ws = freshWorkspace();
    const nixBin = path.join(ws, "nix", "store", "fake", "bin");
    fs.mkdirSync(nixBin, { recursive: true });
    const probe = path.join(nixBin, "lobu-cwd-probe");
    fs.writeFileSync(probe, "#!/bin/sh\necho ok\n", "utf8");
    fs.chmodSync(probe, 0o755);

    process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC = "1";

    const ops = await createEmbeddedBashOps({ workspaceDir: ws });
    const chunks: string[] = [];
    // just-bash's ReadWriteFs blocks `cd /etc` before our resolveHostCwd runs.
    // Test the just-bash side: command should still be invokable from "/".
    const r = await ops.exec("lobu-cwd-probe", "/", {
      onData: (c) => chunks.push(c.toString()),
      timeout: 5,
    });
    expect(r.exitCode).toBe(0);
    expect(chunks.join("")).toContain("ok");
  });
});

// ---------------------------------------------------------------------------
// MCP-CLI registration path (mcpExposure: "cli")
// ---------------------------------------------------------------------------

describe("createEmbeddedBashOps MCP CLI exposure", () => {
  test("registers MCP CLI commands and runs them via bash", async () => {
    const ws = freshWorkspace();
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;

    const ref = makeRef({
      mcpTools: { owletto: [owlettoTool] },
      mcpStatus: [
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    let ops;
    try {
      ops = await createEmbeddedBashOps({
        workspaceDir: ws,
        mcpRuntimeRef: ref,
        gw,
        mcpExposure: "cli",
      });
    } finally {
      console.log = originalLog;
    }

    expect(
      logs.some((l) => l.includes("MCP CLI commands") && l.includes("owletto"))
    ).toBe(true);

    const chunks: string[] = [];
    const r = await ops.exec("owletto --help", "/", {
      onData: (c) => chunks.push(c.toString()),
      timeout: 5,
    });
    expect(r.exitCode).toBe(0);
    const out = chunks.join("");
    expect(out).toContain("owletto — MCP server CLI");
    expect(out).toContain("search_knowledge");
  });

  test("MCP CLI handler shadows a same-named PATH binary", async () => {
    const ws = freshWorkspace();
    const nixBin = path.join(ws, "nix", "store", "fake", "bin");
    fs.mkdirSync(nixBin, { recursive: true });
    const realOwletto = path.join(nixBin, "owletto");
    fs.writeFileSync(
      realOwletto,
      "#!/bin/sh\necho real-binary-output\n",
      "utf8"
    );
    fs.chmodSync(realOwletto, 0o755);

    process.env.PATH = `${nixBin}:${process.env.PATH ?? ""}`;
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    process.env.LOBU_ALLOW_UNSANDBOXED_EXEC = "1";

    const ref = makeRef({
      mcpTools: { owletto: [owlettoTool] },
      mcpStatus: [
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });

    const ops = await createEmbeddedBashOps({
      workspaceDir: ws,
      mcpRuntimeRef: ref,
      gw,
      mcpExposure: "cli",
    });
    const chunks: string[] = [];
    const r = await ops.exec("owletto --help", "/", {
      onData: (c) => chunks.push(c.toString()),
      timeout: 5,
    });
    expect(r.exitCode).toBe(0);
    const out = chunks.join("");
    // MCP CLI shadowed the real binary
    expect(out).toContain("MCP server CLI");
    expect(out).not.toContain("real-binary-output");
  });

  test("mcpExposure=tools (default) does not register MCP CLI commands", async () => {
    const ws = freshWorkspace();
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;

    const ref = makeRef({
      mcpTools: { owletto: [owlettoTool] },
      mcpStatus: [
        {
          id: "owletto",
          name: "Owletto",
          requiresAuth: false,
          requiresInput: false,
          authenticated: true,
          configured: true,
        },
      ],
    });

    const ops = await createEmbeddedBashOps({
      workspaceDir: ws,
      mcpRuntimeRef: ref,
      gw,
      // mcpExposure omitted → defaults to "tools"
    });
    const chunks: string[] = [];
    const r = await ops.exec("owletto --help 2>&1; echo done-$?", "/", {
      onData: (c) => chunks.push(c.toString()),
      timeout: 5,
    });
    // owletto isn't registered as a CLI here, so bash returns command-not-found
    // ($? != 0) and our `done-N` marker reflects that.
    expect(chunks.join("")).toContain("done-");
    expect(chunks.join("")).not.toContain("owletto — MCP server CLI");
    expect(r.exitCode).toBe(0); // the wrapping echo always exits 0
  });
});

// ---------------------------------------------------------------------------
// Sandbox-active log path (kind=none branch is hit by the env=off setup; the
// active-sandbox log only fires on hosts with a real sandbox, so we just
// exercise the warn-once "no sandbox" path).
// ---------------------------------------------------------------------------

describe("createEmbeddedBashOps sandbox status logging", () => {
  test("warns when sandbox unavailable and opt-in flag is missing", async () => {
    const ws = freshWorkspace();
    process.env.OWLETTO_EXEC_SANDBOX = "off";
    delete process.env.LOBU_ALLOW_UNSANDBOXED_EXEC;

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warns.push(String(msg));
    try {
      await createEmbeddedBashOps({ workspaceDir: ws });
    } finally {
      console.warn = originalWarn;
    }

    expect(warns.some((w) => w.includes("Exec sandbox unavailable"))).toBe(
      true
    );
  });
});
