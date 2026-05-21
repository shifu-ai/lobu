import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesiredStateFromConfig } from "../desired-state.js";

// Fixtures live under the worktree (next to this test) so that the externalized
// `@lobu/sdk` import in the generated bundle resolves from node_modules.
describe("loadDesiredStateFromConfig", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("bundles + imports lobu.config.ts and maps it to DesiredState", async () => {
    dir = mkdtempSync(join(import.meta.dir, "fixture-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineEntityType } from "@lobu/sdk";`,
        `const person = defineEntityType({ key: "person" });`,
        `export default defineConfig({`,
        `  org: "test-org",`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  entities: [person],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state, configPath } = await loadDesiredStateFromConfig({
      cwd: dir,
    });
    expect(configPath).toContain("lobu.config.ts");
    expect(state.memory).toEqual({ org: "test-org" });
    expect(state.agents[0]?.metadata.agentId).toBe("crm");
    expect(state.memorySchema.entityTypes[0]?.slug).toBe("person");
  });

  test("rejects when no lobu.config.ts is present", async () => {
    dir = mkdtempSync(join(import.meta.dir, "empty-"));
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /No lobu\.config\.ts/
    );
  });

  test("rejects a config whose default export is not defineConfig()", async () => {
    dir = mkdtempSync(join(import.meta.dir, "bad-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      `export default { nope: true };\n`
    );
    await expect(loadDesiredStateFromConfig({ cwd: dir })).rejects.toThrow(
      /defineConfig/
    );
  });
});
