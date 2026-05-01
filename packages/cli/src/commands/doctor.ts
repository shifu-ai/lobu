import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { checkMemoryHealth } from "./memory/_lib/openclaw-cmd.js";
import { resolveServerUrl } from "./memory/_lib/openclaw-auth.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function checkBinaryExists(name: string): Check {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(cmd, [name], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const first = out.split("\n")[0]?.trim();
    if (!first) return { name, status: "fail", detail: "not found" };
    return { name, status: "ok", detail: first };
  } catch {
    return { name, status: "fail", detail: "not found" };
  }
}

function checkNodeVersion(): Check {
  const version = process.version;
  const major = Number.parseInt(version.slice(1), 10);
  return {
    name: "node",
    status: major >= 22 ? "ok" : "warn",
    detail: version,
  };
}

async function checkServerReachable(url: string): Promise<Check> {
  const origin = new URL(url).origin;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(origin, { signal: controller.signal });
    clearTimeout(timer);
    return {
      name: "server",
      status: res.ok ? "ok" : "warn",
      detail: `${res.status} ${origin}`,
    };
  } catch {
    return { name: "server", status: "fail", detail: `unreachable: ${origin}` };
  }
}

interface DoctorOptions {
  memoryOnly?: boolean;
}

export async function doctorCommand(
  options: DoctorOptions = {}
): Promise<void> {
  if (options.memoryOnly) {
    await checkMemoryHealth();
    return;
  }

  const checks: Check[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkBinaryExists("git"));

  const serverUrl = await resolveServerUrl();
  if (serverUrl) checks.push(await checkServerReachable(serverUrl));

  const icons = {
    ok: chalk.green("✓"),
    warn: chalk.yellow("!"),
    fail: chalk.red("✗"),
  };
  for (const c of checks) {
    console.log(
      `  ${icons[c.status]} ${chalk.bold(c.name)}: ${chalk.dim(c.detail)}`
    );
  }

  const fails = checks.filter((c) => c.status === "fail");
  if (fails.length > 0) {
    console.log(`\n${fails.length} issue(s) found.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${chalk.green("All checks passed.")}`);
  }
}
