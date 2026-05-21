import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("ships local connectors/*.connector.ts source referenced by a connection", async () => {
    dir = mkdtempSync(join(import.meta.dir, "connector-"));
    mkdirSync(join(dir, "connectors"));
    writeFileSync(
      join(dir, "connectors", "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({`,
        `  key: "weather",`,
        `  feeds: { current: { sync: async () => [] } },`,
        `});`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig, defineConnection } from "@lobu/sdk";`,
        `export default defineConfig({`,
        `  agents: [defineAgent({ id: "crm" })],`,
        `  connections: [defineConnection({ slug: "weather", connector: "weather" })],`,
        `});`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(1);
    const def = state.connectors.definitions[0];
    expect(def?.key).toBeNull();
    expect(def?.sourceFile).toBe("connectors/weather.connector.ts");
    expect(def?.sourcePath).toContain("weather.connector.ts");
    expect(def?.sourceCode).toContain("defineConnector");
    // The connection references the connector by key; the server resolves the
    // null key when it compiles the shipped source.
    expect(state.connectors.connections[0]?.connector).toBe("weather");
  });

  test("--only agents skips local connector definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "only-"));
    mkdirSync(join(dir, "connectors"));
    writeFileSync(
      join(dir, "connectors", "weather.connector.ts"),
      [
        `import { defineConnector } from "@lobu/connector-sdk/define-connector";`,
        `export default defineConnector({ key: "weather", feeds: { current: { sync: async () => [] } } });`,
        ``,
      ].join("\n")
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/sdk";`,
        `export default defineConfig({ agents: [defineAgent({ id: "crm" })] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({
      cwd: dir,
      only: "agents",
    });
    expect(state.connectors.definitions).toHaveLength(0);
  });

  test("discovers multiple .connector.ts files sorted, ignoring non-matching files and subdirs", async () => {
    dir = mkdtempSync(join(import.meta.dir, "multi-"));
    mkdirSync(join(dir, "connectors"));
    const connectorSrc = `import { defineConnector } from "@lobu/connector-sdk/define-connector";\nexport default defineConnector({ key: "x", feeds: {} });\n`;
    // Out-of-order on disk; result must be sorted by sourceFile.
    writeFileSync(join(dir, "connectors", "beta.connector.ts"), connectorSrc);
    writeFileSync(join(dir, "connectors", "alpha.connector.ts"), connectorSrc);
    // Non-matching files are ignored.
    writeFileSync(
      join(dir, "connectors", "helper.ts"),
      `export const x = 1;\n`
    );
    writeFileSync(join(dir, "connectors", "README.md"), `# connectors\n`);
    // Nested .connector.ts is ignored (scan is non-recursive).
    mkdirSync(join(dir, "connectors", "nested"));
    writeFileSync(
      join(dir, "connectors", "nested", "deep.connector.ts"),
      connectorSrc
    );
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/sdk";`,
        `export default defineConfig({ agents: [defineAgent({ id: "crm" })] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions.map((d) => d.sourceFile)).toEqual([
      "connectors/alpha.connector.ts",
      "connectors/beta.connector.ts",
    ]);
  });

  test("no connectors/ dir → no definitions", async () => {
    dir = mkdtempSync(join(import.meta.dir, "nodir-"));
    writeFileSync(
      join(dir, "lobu.config.ts"),
      [
        `import { defineAgent, defineConfig } from "@lobu/sdk";`,
        `export default defineConfig({ agents: [defineAgent({ id: "crm" })] });`,
        ``,
      ].join("\n")
    );

    const { state } = await loadDesiredStateFromConfig({ cwd: dir });
    expect(state.connectors.definitions).toHaveLength(0);
  });
});
