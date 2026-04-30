import chalk from "chalk";
import { loadAgentContext } from "../../config/agent-helpers.js";
import { PLATFORM_LABELS } from "./platform-prompts.js";

export async function platformsListCommand(cwd: string): Promise<void> {
  const ctx = await loadAgentContext(cwd);
  if (!ctx) return;

  console.log();
  for (const [agentId, agent] of Object.entries(ctx.agents)) {
    const platforms = (agent.platforms ?? []) as Array<Record<string, unknown>>;
    console.log(chalk.bold(`  ${agentId}`));
    if (platforms.length === 0) {
      console.log(chalk.dim("    (no platforms configured)"));
    } else {
      for (const p of platforms) {
        const type = p.type as string;
        const label = PLATFORM_LABELS[type] ?? type;
        console.log(
          `    ${chalk.cyan("●")} ${label} ${chalk.dim(`(${type})`)}`
        );
      }
    }
    console.log();
  }
}
