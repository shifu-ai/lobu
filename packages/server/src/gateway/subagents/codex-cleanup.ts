import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** Crash recovery for credential-bearing directories; task workspaces are retained. */
export async function cleanupCodexTemporaryHomes(stateRoot: string, now = Date.now()): Promise<number> {
  const cutoff = now - 2 * 60 * 60 * 1000; // Beyond 30-minute tasks and 10-minute login flows.
  let removed = 0;
  const directories = async (path: string): Promise<string[]> => {
    try {
      if (!(await lstat(path)).isDirectory()) return [];
      return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const removeOld = async (path: string) => {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) return;
      await rm(path, { recursive: true, force: true }); removed++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  for (const account of await directories(join(stateRoot, "accounts"))) {
    if (!/^[a-f0-9]{64}$/.test(account)) continue;
    const directory = join(stateRoot, "accounts", account);
    for (const child of await directories(directory)) {
      if (/^refresh-[a-zA-Z0-9]+$/.test(child)) await removeOld(join(directory, child));
    }
    for (const flow of await directories(join(directory, "auth"))) {
      if (/^[a-f0-9-]{36}-\d+$/.test(flow)) await removeOld(join(directory, "auth", flow));
    }
    for (const task of await directories(join(directory, "tasks"))) {
      if (!/^[a-f0-9-]{36}$/.test(task)) continue;
      for (const generation of await directories(join(directory, "tasks", task))) {
        if (!/^\d+$/.test(generation)) continue;
        for (const home of ["home", "codex"]) await removeOld(join(directory, "tasks", task, generation, home));
      }
    }
  }
  return removed;
}
