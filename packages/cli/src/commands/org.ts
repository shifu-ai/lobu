import chalk from "chalk";
import {
  getActiveOrg,
  listOrganizations,
  resolveContext,
  setActiveOrg,
} from "../internal/index.js";

export async function orgListCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const active = await getActiveOrg();
  const orgs = await listOrganizations({ context: target.name });

  if (orgs.length === 0) {
    console.log(chalk.dim("\n  No organizations found for this login.\n"));
    return;
  }

  console.log(chalk.bold("\n  Organizations"));
  for (const org of orgs) {
    const marker = org.slug === active ? chalk.green("*") : " ";
    const name = org.name ? chalk.dim(`  ${org.name}`) : "";
    console.log(`${marker} ${org.slug}${name}`);
  }
  console.log();
}

export async function orgCurrentCommand(): Promise<void> {
  const active = await getActiveOrg();
  if (!active) {
    console.log(
      chalk.dim("\n  No active org set. Run `lobu org set <slug>`.\n")
    );
    return;
  }
  console.log(chalk.bold("\n  Current org"));
  console.log(chalk.dim(`  ${active}\n`));
}

export async function orgSetCommand(slug: string): Promise<void> {
  await setActiveOrg(slug);
  console.log(chalk.green(`\n  Active org set to ${slug}\n`));
}
