import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";

interface AgentStatusItem {
  agentId: string;
  name: string;
  connectionCount?: number;
  activeConnectionCount?: number;
  clientCount?: number;
  status?: string;
}

export async function statusCommand(
  options: { context?: string; org?: string } = {}
): Promise<void> {
  const { client, orgSlug, apiBaseUrl } = await resolveApiClient(options);
  const data = await client.get<{ agents?: AgentStatusItem[] }>(
    `/api/${orgSlug}/agents`
  );
  const agents = data.agents ?? [];

  console.log(chalk.bold("\n  Lobu"));
  console.log(chalk.dim(`  API: ${apiBaseUrl}`));
  console.log(chalk.dim(`  Org: ${orgSlug}`));

  if (agents.length === 0) {
    console.log(chalk.yellow("\n  No agents configured.\n"));
    return;
  }

  console.log(chalk.bold.cyan("\n  Agents"));
  for (const agent of agents) {
    const active =
      agent.status === "active" || (agent.activeConnectionCount ?? 0) > 0;
    const icon = active ? chalk.green("●") : chalk.dim("○");
    console.log(
      `  ${icon} ${chalk.bold(agent.name)} ${chalk.dim(`(${agent.agentId})`)}  ${chalk.dim(
        `connections:${agent.connectionCount ?? 0} active:${agent.activeConnectionCount ?? 0} clients:${agent.clientCount ?? 0}`
      )}`
    );
  }
  console.log();
}
