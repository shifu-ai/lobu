import chalk from "chalk";
import { getToken, resolveContext } from "../internal/index.js";
import { resolveApiClient } from "../internal/api-client.js";

interface TokenCreateOptions {
  context?: string;
  org?: string;
  name?: string;
  description?: string;
  scope?: string;
  expiresInDays?: number;
  raw?: boolean;
  json?: boolean;
}

interface CreatedPersonalAccessToken {
  id: number;
  token: string;
  token_prefix: string;
  name: string;
  scope: string | null;
  expires_at: string | null;
  created_at: string;
}

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

export async function tokenCreateCommand(
  options: TokenCreateOptions
): Promise<void> {
  const { client, orgSlug, contextName } = await resolveApiClient({
    context: options.context,
    org: options.org,
  });
  const name = options.name?.trim() || defaultTokenName();
  const scope = options.scope?.trim() || "mcp:read mcp:write";

  const response = await client.post<{ token: CreatedPersonalAccessToken }>(
    `/api/${encodeURIComponent(orgSlug)}/tokens`,
    {
      name,
      scope,
      ...(options.description ? { description: options.description } : {}),
      ...(options.expiresInDays !== undefined
        ? { expiresInDays: options.expiresInDays }
        : {}),
    }
  );

  if (options.raw) {
    process.stdout.write(`${response.token.token}\n`);
    return;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.token, null, 2)}\n`);
    return;
  }

  console.log(chalk.cyan("\n  Personal access token created"));
  console.log(chalk.dim(`  Context: ${contextName}`));
  console.log(chalk.dim(`  Org:     ${orgSlug}`));
  console.log(chalk.dim(`  Name:    ${response.token.name}`));
  console.log(chalk.dim(`  Scope:   ${response.token.scope ?? scope}`));
  console.log(
    chalk.dim(
      `  Expires: ${response.token.expires_at ? new Date(response.token.expires_at).toISOString() : "never"}`
    )
  );
  console.log(
    chalk.yellow("\n  Save this token now; it will not be shown again:")
  );
  console.log(`  ${response.token.token}\n`);
}

function defaultTokenName(): string {
  return `lobu-cli-${new Date().toISOString().slice(0, 10)}`;
}
