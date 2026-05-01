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
  const active = await getActiveOrg(target.name);
  const orgs = await listOrganizations({ context: target.name });

  if (orgs.length === 0) {
    console.log(chalk.dim("\n  No organizations found for this login.\n"));
    return;
  }

  console.log(chalk.bold(`\n  Organizations in ${target.name}`));
  for (const org of orgs) {
    const marker = org.slug === active ? chalk.green("*") : " ";
    const name = org.name ? chalk.dim(`  ${org.name}`) : "";
    console.log(`${marker} ${org.slug}${name}`);
  }
  console.log();
}

export async function orgCurrentCommand(options?: {
  context?: string;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const active = await getActiveOrg(target.name);
  if (!active) {
    console.log(
      chalk.dim(
        `\n  No active org set for context ${target.name}. Run \`lobu org set <slug>\`.\n`
      )
    );
    return;
  }
  console.log(chalk.bold(`\n  Current org for context ${target.name}`));
  console.log(chalk.dim(`  ${active}\n`));
}

export async function orgSetCommand(
  slug: string,
  options?: { context?: string }
): Promise<void> {
  const target = await resolveContext(options?.context);
  await setActiveOrg(slug, target.name);
  console.log(
    chalk.green(`\n  Active org for context ${target.name} set to ${slug}\n`)
  );
}
