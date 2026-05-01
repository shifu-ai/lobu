import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function setLocalEnvValue(
  cwd: string,
  key: string,
  value: string
): Promise<void> {
  const envPath = join(cwd, ".env");
  let content = "";
  try {
    content = await readFile(envPath, "utf-8");
  } catch {
    content = "";
  }

  const serialized = `${key}=${formatEnvValue(value)}`;
  const trimmed = content.trimEnd();
  const lines = trimmed ? trimmed.split("\n") : [];
  let found = false;
  const updated = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) {
      found = true;
      return serialized;
    }
    return line;
  });

  if (!found) updated.push(serialized);
  await writeFile(envPath, updated.join("\n"));
}

function formatEnvValue(value: string): string {
  if (!/[\s#"'\\]/.test(value)) return value;
  return JSON.stringify(value);
}
