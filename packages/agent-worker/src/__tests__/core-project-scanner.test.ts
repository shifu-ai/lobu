import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAppDirectories } from "../core/project-scanner";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "project-scanner-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listAppDirectories", () => {
  test("returns empty list when no build config files exist", async () => {
    await writeFile(join(root, "README.md"), "hi");
    await mkdir(join(root, "subdir"));
    await writeFile(join(root, "subdir", "notes.txt"), "x");

    expect(listAppDirectories(root)).toEqual([]);
  });

  test("detects a project at the root level (package.json)", async () => {
    await writeFile(join(root, "package.json"), "{}");

    expect(listAppDirectories(root)).toEqual([root]);
  });

  test("detects multiple build config types", async () => {
    const cases = [
      "Makefile",
      "makefile",
      "pyproject.toml",
      "Cargo.toml",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "CMakeLists.txt",
      "go.mod",
    ];
    for (const file of cases) {
      const dir = await mkdtemp(join(tmpdir(), "scanner-case-"));
      try {
        await writeFile(join(dir, file), "x");
        expect(listAppDirectories(dir)).toEqual([dir]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("recurses into subdirectories and finds nested projects", async () => {
    const a = join(root, "apps", "a");
    const b = join(root, "apps", "b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "package.json"), "{}");
    await writeFile(join(b, "Cargo.toml"), "");

    const found = listAppDirectories(root).sort();
    expect(found).toEqual([a, b].sort());
  });

  test("includes both root and nested projects", async () => {
    const nested = join(root, "service");
    await mkdir(nested);
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(nested, "go.mod"), "module x");

    const found = listAppDirectories(root).sort();
    expect(found).toEqual([root, nested].sort());
  });

  test("ignores node_modules and other excluded directories", async () => {
    const ignored = [
      "node_modules",
      ".git",
      ".next",
      "dist",
      "build",
      "vendor",
      "target",
      ".venv",
      "venv",
    ];
    for (const name of ignored) {
      const dir = join(root, name);
      await mkdir(dir);
      await writeFile(join(dir, "package.json"), "{}");
    }
    // Plus a real project not in ignore set
    const real = join(root, "real");
    await mkdir(real);
    await writeFile(join(real, "package.json"), "{}");

    expect(listAppDirectories(root)).toEqual([real]);
  });

  test("returns empty array for unreadable / nonexistent root", () => {
    const missing = join(root, "does-not-exist");
    expect(listAppDirectories(missing)).toEqual([]);
  });

  test("does not match build config names that are directories", async () => {
    // package.json as a directory name should not count as a config file
    await mkdir(join(root, "package.json"));
    expect(listAppDirectories(root)).toEqual([]);
  });

  test("walks deeply nested trees", async () => {
    const deep = join(root, "a", "b", "c", "d");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "Makefile"), "all:");

    expect(listAppDirectories(root)).toEqual([deep]);
  });
});
