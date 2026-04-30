import chalk from "chalk";
import { getToken, resolveContext } from "../internal/index.js";

export async function tokenCommand(options: {
  context?: string;
  raw?: boolean;
}): Promise<void> {
  const target = await resolveContext(options.context);
  const token = await getToken(target.name);

  if (!token) {
    console.error(chalk.red("\n  Not logged in. Run `lobu login` first.\n"));
    process.exitCode = 1;
    return;
  }

  if (options.raw) {
    process.stdout.write(`${token}\n`);
    return;
  }

  console.log(chalk.cyan(`\n  Context: ${target.name}`));
  console.log(chalk.dim(`  API URL: ${target.apiUrl}`));
  console.log("  Token: available (use `lobu token --raw` to print it)\n");
}
