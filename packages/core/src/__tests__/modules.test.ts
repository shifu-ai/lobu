import { describe, expect, test } from "bun:test";
import {
  type ModuleInterface,
  ModuleRegistry,
  moduleRegistry,
  type WorkerContext,
  type WorkerModule,
} from "../modules";

function makeModule(
  overrides: Partial<ModuleInterface> & { name: string }
): ModuleInterface {
  return {
    isEnabled: () => true,
    init: async () => undefined,
    registerEndpoints: () => undefined,
    ...overrides,
  };
}

function makeWorkerModule(
  overrides: Partial<WorkerModule> & { name: string }
): WorkerModule {
  return {
    isEnabled: () => true,
    init: async () => undefined,
    registerEndpoints: () => undefined,
    initWorkspace: async () => undefined,
    onSessionStart: async (ctx) => ctx,
    onSessionEnd: async () => [],
    onBeforeResponse: async () => null,
    ...overrides,
  };
}

describe("ModuleRegistry.register", () => {
  test("registers a module that reports enabled", () => {
    const reg = new ModuleRegistry();
    reg.register(makeModule({ name: "alpha" }));
    expect(reg.getModules().map((m) => m.name)).toEqual(["alpha"]);
  });

  test("skips modules whose isEnabled() returns false", () => {
    const reg = new ModuleRegistry();
    reg.register(makeModule({ name: "off", isEnabled: () => false }));
    reg.register(makeModule({ name: "on" }));
    expect(reg.getModules().map((m) => m.name)).toEqual(["on"]);
  });

  test("re-registering with the same name overwrites the previous entry", () => {
    const reg = new ModuleRegistry();
    const a = makeModule({ name: "dup" });
    const b = makeModule({ name: "dup" });
    reg.register(a);
    reg.register(b);
    const all = reg.getModules();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(b);
  });
});

describe("ModuleRegistry.getWorkerModules", () => {
  test("returns only modules that implement onBeforeResponse", () => {
    const reg = new ModuleRegistry();
    reg.register(makeModule({ name: "plain" }));
    reg.register(makeWorkerModule({ name: "worker-1" }));
    reg.register(makeWorkerModule({ name: "worker-2" }));

    const workers = reg.getWorkerModules();
    expect(workers.map((m) => m.name).sort()).toEqual(["worker-1", "worker-2"]);
  });

  test("returns an empty array when no worker modules are registered", () => {
    const reg = new ModuleRegistry();
    reg.register(makeModule({ name: "plain" }));
    expect(reg.getWorkerModules()).toEqual([]);
  });
});

describe("ModuleRegistry.initAll", () => {
  test("calls init() on every registered module", async () => {
    const reg = new ModuleRegistry();
    const calls: string[] = [];
    reg.register(
      makeModule({
        name: "m1",
        init: async () => {
          calls.push("m1");
        },
      })
    );
    reg.register(
      makeModule({
        name: "m2",
        init: async () => {
          calls.push("m2");
        },
      })
    );
    await reg.initAll();
    expect(calls.sort()).toEqual(["m1", "m2"]);
  });
});

describe("ModuleRegistry.registerEndpoints", () => {
  test("invokes registerEndpoints on every registered module with the same app", () => {
    const reg = new ModuleRegistry();
    const seenApps: any[] = [];
    reg.register(
      makeModule({
        name: "m1",
        registerEndpoints: (app) => {
          seenApps.push(app);
        },
      })
    );
    reg.register(
      makeModule({
        name: "m2",
        registerEndpoints: (app) => {
          seenApps.push(app);
        },
      })
    );
    const fakeApp = { tag: "express" };
    reg.registerEndpoints(fakeApp);
    expect(seenApps).toHaveLength(2);
    expect(seenApps[0]).toBe(fakeApp);
    expect(seenApps[1]).toBe(fakeApp);
  });

  test("swallows errors thrown from a module's registerEndpoints", () => {
    const reg = new ModuleRegistry();
    let secondCalled = false;
    reg.register(
      makeModule({
        name: "broken",
        registerEndpoints: () => {
          throw new Error("boom");
        },
      })
    );
    reg.register(
      makeModule({
        name: "ok",
        registerEndpoints: () => {
          secondCalled = true;
        },
      })
    );
    // Should not throw; later modules still get a chance.
    expect(() => reg.registerEndpoints({})).not.toThrow();
    expect(secondCalled).toBe(true);
  });
});

describe("ModuleRegistry.registerAvailableModules", () => {
  test("is a no-op when given no package names", async () => {
    const reg = new ModuleRegistry();
    await reg.registerAvailableModules();
    expect(reg.getModules()).toEqual([]);
  });

  test("silently skips packages that fail to import", async () => {
    const reg = new ModuleRegistry();
    await reg.registerAvailableModules([
      "@nonexistent-org/definitely-not-installed-12345",
    ]);
    expect(reg.getModules()).toEqual([]);
  });
});

describe("global moduleRegistry", () => {
  test("is an instance of ModuleRegistry", () => {
    expect(moduleRegistry).toBeInstanceOf(ModuleRegistry);
  });
});

// Type-level smoke check that WorkerContext is usable as a value-shaped object.
describe("WorkerContext shape", () => {
  test("accepts the documented fields", () => {
    const ctx: WorkerContext = {
      workspaceDir: "/tmp/x",
      userId: "u",
      conversationId: "c",
    };
    expect(ctx.workspaceDir).toBe("/tmp/x");
  });
});
