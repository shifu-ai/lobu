import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = process.cwd();

const AUTHORIZATION_ENTRYPOINTS = [
  "packages/server/src/gateway/services/runtime-capability-snapshot.ts",
  "packages/server/src/auth",
  "packages/server/src/gateway/auth",
  "packages/server/src/gateway/permissions",
  "packages/server/src/gateway/routes/internal/tool-approvals.ts",
  "packages/server/src/gateway/routes/public/settings-auth.ts",
  "packages/server/src/gateway/routes/public/connect-auth.ts",
  "packages/server/src/gateway/routes/public/mcp-oauth.ts",
  "packages/server/src/mcp-handler.ts",
  "packages/server/src/mcp-proxy",
  "packages/server/src/tools/admin/manage_connections/handlers/auth-actions.ts",
  "packages/server/src/worker-api/auth-runs.ts",
  "packages/server/src/worker-api/device-auth-profiles.ts",
] as const;

const FORBIDDEN_RELEASE_ASSURANCE_READERS = [
  "readAgentReleaseObservationTruth",
  "readAgentToolInventoryTruth",
  "release-assurance-readback",
] as const;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function productionFiles(path: string): string[] {
  const absolutePath = join(ROOT, path);
  if (!existsSync(absolutePath)) return [];

  const stat = statSync(absolutePath);
  if (stat.isFile()) return shouldScanFile(absolutePath) ? [absolutePath] : [];
  if (!stat.isDirectory()) return [];

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) return [];
      return productionFiles(relative(ROOT, childPath));
    }
    return shouldScanFile(childPath) ? [childPath] : [];
  });
}

function shouldSkipDirectory(name: string): boolean {
  return (
    name === "__tests__" ||
    name === "__fixtures__" ||
    name === "fixtures" ||
    name === "generated" ||
    name === "dist"
  );
}

function shouldScanFile(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? "";
  if (!SOURCE_EXTENSIONS.has(extname(path))) return false;
  if (
    fileName.endsWith(".test.ts") ||
    fileName.endsWith(".test.tsx") ||
    fileName.endsWith(".spec.ts") ||
    fileName.endsWith(".spec.tsx") ||
    fileName.endsWith(".d.ts")
  ) {
    return false;
  }
  return true;
}

describe("release assurance authorization isolation", () => {
  test("runtime authorization modules do not import observation readback", () => {
    const scannedFiles = [
      ...new Set(AUTHORIZATION_ENTRYPOINTS.flatMap(productionFiles)),
    ].sort();

    expect(scannedFiles.map((path) => relative(ROOT, path))).toContain(
      "packages/server/src/gateway/services/runtime-capability-snapshot.ts",
    );

    const violations = scannedFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return FORBIDDEN_RELEASE_ASSURANCE_READERS.flatMap((needle) =>
        source.includes(needle)
          ? [`${relative(ROOT, path)} imports or uses ${needle}`]
          : [],
      );
    });

    expect(violations).toEqual([]);
  });
});
