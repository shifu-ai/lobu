import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvContent } from "./env-file.js";

export const GATEWAY_DEFAULT_URL = "http://localhost:8787";

interface ResolveGatewayUrlOptions {
  cwd?: string;
}

/**
 * Resolve the local gateway URL by reading `GATEWAY_PORT` / `PORT` from the
 * project's `.env` file (if present). Falls back to `GATEWAY_DEFAULT_URL` when
 * the file is missing or neither variable is set.
 */
export async function resolveGatewayUrl(
  options: ResolveGatewayUrlOptions = {}
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    const parsed = parseEnvContent(envContent);
    const port = parsed.GATEWAY_PORT || parsed.PORT;
    if (port) return `http://localhost:${port}`;
  } catch {
    // No .env file
  }
  return GATEWAY_DEFAULT_URL;
}
