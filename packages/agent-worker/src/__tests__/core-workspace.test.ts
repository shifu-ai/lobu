import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "@lobu/core";
import { WorkspaceManager } from "../core/workspace";

let root: string;
let originalConversationId: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspace-mgr-test-"));
  originalConversationId = process.env.CONVERSATION_ID;
  delete process.env.CONVERSATION_ID;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (originalConversationId !== undefined)
    process.env.CONVERSATION_ID = originalConversationId;
  else delete process.env.CONVERSATION_ID;
});

describe("WorkspaceManager", () => {
  test("getCurrentWorkingDirectory returns baseDirectory before setup", () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });
    expect(mgr.getCurrentWorkingDirectory()).toBe(root);
  });

  test("setupWorkspace creates base + thread directory using sessionKey", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });
    const sessionKey = "session-abc-123";

    const info = await mgr.setupWorkspace("alice", sessionKey);

    expect(info.baseDirectory).toBe(root);
    expect(info.userDirectory).toBe(`${root}/${sessionKey}`);

    // Both directories actually exist
    expect((await stat(info.baseDirectory)).isDirectory()).toBe(true);
    expect((await stat(info.userDirectory)).isDirectory()).toBe(true);
  });

  test("setupWorkspace prefers CONVERSATION_ID env over sessionKey/username", async () => {
    process.env.CONVERSATION_ID = "1756766056.836119";
    const mgr = new WorkspaceManager({ baseDirectory: root });

    const info = await mgr.setupWorkspace("alice", "ignored-session");

    expect(info.userDirectory).toBe(`${root}/1756766056.836119`);
  });

  test("setupWorkspace falls back to username when no env or sessionKey", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });

    const info = await mgr.setupWorkspace("bob");

    expect(info.userDirectory).toBe(`${root}/bob`);
  });

  test("setupWorkspace falls back to 'default' when nothing is provided", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });

    // empty string username -> falls through to "default"
    const info = await mgr.setupWorkspace("");

    expect(info.userDirectory).toBe(`${root}/default`);
  });

  test("setupWorkspace sanitizes unsafe characters in conversation id", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });

    // sanitizeConversationId replaces /, spaces, : etc. with _ but keeps dots
    const info = await mgr.setupWorkspace("alice", "thread/123/../456");

    expect(info.userDirectory).toBe(`${root}/thread_123_.._456`);
    expect((await stat(info.userDirectory)).isDirectory()).toBe(true);
  });

  test("getCurrentWorkingDirectory returns thread dir after setup", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });
    const info = await mgr.setupWorkspace("alice", "key1");

    expect(mgr.getCurrentWorkingDirectory()).toBe(info.userDirectory);
  });

  test("setupWorkspace is idempotent — running twice does not error", async () => {
    const mgr = new WorkspaceManager({ baseDirectory: root });
    const a = await mgr.setupWorkspace("alice", "same-key");
    const b = await mgr.setupWorkspace("alice", "same-key");

    expect(a.userDirectory).toBe(b.userDirectory);
    expect((await stat(a.userDirectory)).isDirectory()).toBe(true);
  });

  test("setupWorkspace wraps mkdir failures in WorkspaceError", async () => {
    // Use a base path under a regular file -> mkdir will fail with ENOTDIR
    const file = join(root, "notadir");
    await Bun.write(file, "i am a file");

    const mgr = new WorkspaceManager({
      baseDirectory: join(file, "child"),
    });

    let caught: unknown;
    try {
      await mgr.setupWorkspace("alice", "x");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WorkspaceError);
    const we = caught as WorkspaceError;
    expect(we.operation).toBe("setupWorkspace");
    expect(we.message).toContain("Failed to setup workspace directory");
    expect(we.cause).toBeDefined();
  });
});
