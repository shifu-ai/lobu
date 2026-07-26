import type { Context } from "hono";
import type { Env } from "../index";

export function requireAdminPat(
  c: Context<{ Bindings: Env }>,
): Response | null {
  const session = c.get("session") as { id?: string } | null;
  const authSource = c.get("authSource") as "pat" | "session" | "oauth" | null;
  const authInfo = c.get("mcpAuthInfo") as { scopes?: string[] } | null;
  const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

  if (
    authSource === "pat" &&
    session?.id?.startsWith("pat:") &&
    scopes.includes("mcp:admin")
  ) {
    return null;
  }

  return c.json(
    {
      error: "forbidden",
      error_description:
        "Provisioning requires an organization-scoped PAT with mcp:admin scope.",
    },
    403,
  );
}
