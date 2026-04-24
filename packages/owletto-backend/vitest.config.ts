import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const PACKAGE_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Anchor vitest to this package so test-db.ts's `process.cwd()`-based
  // migration resolution works the same way whether `vitest` is invoked from
  // the repo root (e.g. via `bunx vitest --config packages/...`) or from
  // inside the package.
  root: PACKAGE_ROOT,
  test: {
    globalSetup: ["./src/__tests__/setup/global-setup.ts"],
    // Integration tests need a DB ready before any test file starts. Unit tests
    // don't touch the DB, so they run fast regardless.
    include: ["src/**/*.test.ts"],
    // bun:test-style unit tests live alongside vitest integration tests — skip
    // those for vitest. They run via `bun test` (see the existing CI command).
    exclude: ["src/__tests__/unit/**", "**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests share one Postgres/PGlite. Running multiple files in
    // parallel means one file's `cleanupTestDatabase()` can wipe another file's
    // fixtures mid-run. Serialize files so fixtures stay stable.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
