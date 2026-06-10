/**
 * Shared platform prompt/config logic.
 * Used by `lobu init` when scaffolding optional local platform config.
 */

import { input, password } from "@inquirer/prompts";
import { getPlatformDefinition } from "./registry.js";

interface PlatformPromptResult {
  platformConfig: Record<string, string>;
  platformSecrets: Array<{ envVar: string; value: string }>;
}

export async function promptPlatformConfig(
  platform: string
): Promise<PlatformPromptResult> {
  const platformConfig: Record<string, string> = {};
  const platformSecrets: Array<{ envVar: string; value: string }> = [];

  const def = getPlatformDefinition(platform);
  if (!def) return { platformConfig, platformSecrets };

  for (const line of def.intro ?? []) {
    console.log(line);
  }

  const values: Record<string, string> = {};
  for (const field of def.fields) {
    const value = field.secret
      ? await password({ message: field.label, mask: true })
      : await input({ message: field.label });
    values[field.key] = value;
    if (value) {
      platformConfig[field.key] = `$${field.envVar}`;
      platformSecrets.push({ envVar: field.envVar, value });
    }
  }
  def.finalize?.(platformConfig, values);

  return { platformConfig, platformSecrets };
}
