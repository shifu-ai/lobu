import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../template";

describe("renderTemplate", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "render-template-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("renders an existing template and substitutes variables", async () => {
    const outputPath = join(workDir, "README.md");
    await renderTemplate(
      "README.md.tmpl",
      { PROJECT_NAME: "my-cool-project", CLI_VERSION: "1.2.3" },
      outputPath
    );
    const rendered = await readFile(outputPath, "utf-8");
    expect(rendered).toContain("# my-cool-project");
    expect(rendered).toContain("Lobu instance created with `@lobu/cli` v1.2.3");
    // Variables not in the substitution map are left untouched.
    expect(rendered).toContain("{PUBLIC_GATEWAY_URL}");
  });

  test("creates intermediate output directories", async () => {
    const outputPath = join(workDir, "nested", "dir", "AGENTS.md");
    await renderTemplate("AGENTS.md.tmpl", {}, outputPath);
    const rendered = await readFile(outputPath, "utf-8");
    expect(rendered).toBe("@TESTING.md");
    const dirStat = await stat(join(workDir, "nested", "dir"));
    expect(dirStat.isDirectory()).toBe(true);
  });

  test("throws when the template does not exist", async () => {
    const outputPath = join(workDir, "out.md");
    await expect(
      renderTemplate("does-not-exist.tmpl", {}, outputPath)
    ).rejects.toThrow();
  });

  test("replaces all occurrences of a variable globally", async () => {
    const outputPath = join(workDir, "out.md");
    // README template uses {{PROJECT_NAME}} once, but it should still respect /g.
    await renderTemplate(
      "README.md.tmpl",
      { PROJECT_NAME: "X", CLI_VERSION: "Y" },
      outputPath
    );
    const rendered = await readFile(outputPath, "utf-8");
    // No leftover {{PROJECT_NAME}} or {{CLI_VERSION}} placeholders.
    expect(rendered).not.toContain("{{PROJECT_NAME}}");
    expect(rendered).not.toContain("{{CLI_VERSION}}");
  });

  test("leaves placeholders intact when no variables are supplied", async () => {
    const outputPath = join(workDir, "out.md");
    await renderTemplate("README.md.tmpl", {}, outputPath);
    const rendered = await readFile(outputPath, "utf-8");
    expect(rendered).toContain("{{PROJECT_NAME}}");
    expect(rendered).toContain("{{CLI_VERSION}}");
  });
});
