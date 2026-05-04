import { describe, expect, test } from "bun:test";
import {
  type CommandContext,
  type CommandDefinition,
  CommandRegistry,
} from "../command-registry";

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  replies: { text: string; options?: any }[];
} {
  const replies: { text: string; options?: any }[] = [];
  const ctx: CommandContext = {
    userId: "u1",
    channelId: "c1",
    args: "",
    platform: "test",
    reply: async (text, options) => {
      replies.push({ text, options });
    },
    ...overrides,
  };
  return { ctx, replies };
}

function cmd(
  name: string,
  handler: CommandDefinition["handler"],
  description = `desc-${name}`
): CommandDefinition {
  return { name, description, handler };
}

describe("CommandRegistry", () => {
  test("register + get returns the same definition", () => {
    const registry = new CommandRegistry();
    const def = cmd("ping", async () => undefined);
    registry.register(def);
    expect(registry.get("ping")).toBe(def);
  });

  test("get returns undefined for unknown commands", () => {
    const registry = new CommandRegistry();
    expect(registry.get("nope")).toBeUndefined();
  });

  test("re-registering a command overwrites the previous definition", () => {
    const registry = new CommandRegistry();
    const first = cmd("ping", async () => undefined);
    const second = cmd("ping", async () => undefined);
    registry.register(first);
    registry.register(second);
    expect(registry.get("ping")).toBe(second);
    expect(registry.getAll()).toHaveLength(1);
  });

  test("getAll returns every registered command", () => {
    const registry = new CommandRegistry();
    registry.register(cmd("a", async () => undefined));
    registry.register(cmd("b", async () => undefined));
    registry.register(cmd("c", async () => undefined));
    const names = registry
      .getAll()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  test("tryHandle returns false and does not reply for unknown commands", async () => {
    const registry = new CommandRegistry();
    const { ctx, replies } = makeCtx();
    const handled = await registry.tryHandle("ghost", ctx);
    expect(handled).toBe(false);
    expect(replies).toHaveLength(0);
  });

  test("tryHandle invokes the handler and returns true on success", async () => {
    const registry = new CommandRegistry();
    let called = false;
    let receivedArgs = "";
    registry.register(
      cmd("echo", async (c) => {
        called = true;
        receivedArgs = c.args;
        await c.reply(`got:${c.args}`);
      })
    );
    const { ctx, replies } = makeCtx({ args: "hello" });
    const handled = await registry.tryHandle("echo", ctx);
    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(receivedArgs).toBe("hello");
    expect(replies).toEqual([{ text: "got:hello", options: undefined }]);
  });

  test("tryHandle returns true and replies with an error message when the handler throws", async () => {
    const registry = new CommandRegistry();
    registry.register(
      cmd("boom", async () => {
        throw new Error("kaboom");
      })
    );
    const { ctx, replies } = makeCtx();
    const handled = await registry.tryHandle("boom", ctx);
    expect(handled).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain("something went wrong");
  });
});
