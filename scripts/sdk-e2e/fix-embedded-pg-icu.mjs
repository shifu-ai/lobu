#!/usr/bin/env node
/**
 * Make `lobu run`'s embedded Postgres self-contained on Linux — zero system deps.
 *
 * The @embedded-postgres PG18 binaries (initdb/postgres) are dynamically linked
 * against ICU 60 (NEEDED: libicuuc.so.60 → libicui18n.so.60 → libicudata.so.60)
 * and carry an rpath of `$ORIGIN/../lib`, i.e. they look for their ICU next to
 * themselves in `<pkg>/native/lib`. That dir already SHIPS the libraries — but
 * only under their fully-versioned names (libicuuc.so.60.2, …). What's missing
 * is the SONAME symlink (libicuuc.so.60 → libicuuc.so.60.2) that a normal ICU
 * package/install would create, so the loader can't resolve the NEEDED soname
 * and initdb fails to start on any host without a system ICU 60.
 *
 * Creating those three symlinks makes the bundled rpath resolve with no system
 * install, no LD_LIBRARY_PATH, no apt/.deb download — works identically in CI
 * (ubuntu-latest) and on a local Linux dev box. macOS ships matching `.dylib`s
 * with the right install names already, so this is a Linux-only no-op there.
 *
 * Idempotent: re-running just re-points the symlinks. Exits 0 on non-Linux or
 * when the linux platform package isn't installed (the wrong-arch optional dep).
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "linux") {
  // macOS / Windows resolve their bundled ICU without SONAME symlinks.
  process.exit(0);
}

const require = createRequire(import.meta.url);

// The ICU libs the PG18 binaries are NEEDED-linked against. Each maps its
// SONAME (`.so.60`) to the versioned file the package actually ships
// (`.so.60.2`). If a future @embedded-postgres bumps the patch suffix we
// glob-match below, so the exact `.2` here is only the preferred target.
const ICU_SONAMES = ["libicuuc", "libicui18n", "libicudata"];

/** Locate every installed @embedded-postgres/linux-* native lib dir. */
function findLinuxNativeLibDirs() {
  const dirs = new Set();
  // Candidate `node_modules` roots to scan for the @embedded-postgres scope:
  //  1. wherever `embedded-postgres` resolves from this helper (the workspace
  //     hoist root in CI / monorepo), and
  //  2. `<cwd>/node_modules` (covers a project-local install or a tree this
  //     helper was copied into).
  const scopeRoots = new Set();
  try {
    const ep = require.resolve("embedded-postgres/package.json");
    scopeRoots.add(resolve(dirname(ep), ".."));
  } catch {
    // not resolvable from here — fall through to cwd
  }
  scopeRoots.add(resolve(process.cwd(), "node_modules"));

  for (const root of scopeRoots) {
    const scopeDir = join(root, "@embedded-postgres");
    if (!existsSync(scopeDir)) continue;
    for (const name of readdirSync(scopeDir)) {
      if (!name.startsWith("linux-")) continue;
      const libDir = join(scopeDir, name, "native", "lib");
      if (existsSync(libDir)) dirs.add(libDir);
    }
  }
  return [...dirs];
}

function ensureSonameSymlink(libDir, soname) {
  // Find the concrete versioned file: libicuuc.so.60.2 (or any .so.<major>.<n>).
  const candidates = readdirSync(libDir).filter((f) =>
    new RegExp(`^${soname}\\.so\\.\\d+\\.\\d+$`).test(f)
  );
  if (candidates.length === 0) return { soname, status: "no-versioned-file" };
  // Newest patch wins if several exist.
  candidates.sort();
  const target = candidates[candidates.length - 1];
  const major = target.match(/\.so\.(\d+)\./)?.[1];
  if (!major) return { soname, status: "unparseable" };
  const link = join(libDir, `${soname}.so.${major}`);

  if (existsSync(link) || isDanglingSymlink(link)) {
    // Already correct? Leave it. Otherwise re-point (idempotent).
    if (isSymlinkTo(link, target)) return { soname, status: "ok" };
    unlinkSync(link);
  }
  symlinkSync(target, link); // relative target → stays valid if the dir moves
  return {
    soname,
    status: "linked",
    link: `${soname}.so.${major} -> ${target}`,
  };
}

function isDanglingSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink() && !existsSync(p);
  } catch {
    return false;
  }
}

function isSymlinkTo(p, target) {
  try {
    return lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;
  } catch {
    return false;
  }
}

const libDirs = findLinuxNativeLibDirs();
if (libDirs.length === 0) {
  // Wrong-arch optional dep not installed (e.g. running this on darwin's tree)
  // — nothing to fix. Embedded PG simply isn't available on this host.
  console.log(
    "[fix-embedded-pg-icu] no @embedded-postgres/linux-* lib dir; skip"
  );
  process.exit(0);
}

let linked = 0;
for (const libDir of libDirs) {
  for (const soname of ICU_SONAMES) {
    const r = ensureSonameSymlink(libDir, soname);
    if (r.status === "linked") {
      linked++;
      console.log(`[fix-embedded-pg-icu] ${libDir}: ${r.link}`);
    } else if (r.status === "no-versioned-file") {
      console.log(
        `[fix-embedded-pg-icu] ${libDir}: ${soname} has no versioned .so — package layout changed?`
      );
    }
  }
}
console.log(
  `[fix-embedded-pg-icu] done (${linked} symlink(s) created across ${libDirs.length} lib dir(s))`
);
