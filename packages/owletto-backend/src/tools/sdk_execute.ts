/**
 * MCP tool `execute` — runs a TypeScript script in an isolated-vm sandbox
 * over the typed `ClientSDK`. Replaces the action-discriminated `manage_*`
 * tool surface (those handlers stay; the SDK delegates to them).
 *
 * Auth: requires `write` access. Per-method access checks fire inside the
 * delegated handlers, so admin-only SDK calls still require admin role and
 * `mcp:admin` scope before they run.
 */

import { type Static, Type } from "@sinclair/typebox";
import type { Env } from "../index";
import { buildClientSDK } from "../sandbox/client-sdk";
import { runScript } from "../sandbox/run-script";
import type { ToolContext } from "./registry";

export const ExecuteSchema = Type.Object({
  script: Type.String({
    description:
      "TypeScript source. Must `export default async (ctx, client) => { ... }`. The `client` global exposes typed namespaces (entities, watchers, knowledge, etc.) plus `client.org(slug)` for cross-org calls. Use `search` to discover methods.",
    minLength: 1,
    maxLength: 100_000,
  }),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Wall-clock budget. Default 60000 (max 60000).",
      minimum: 100,
      maximum: 60_000,
    }),
  ),
});

export type ExecuteArgs = Static<typeof ExecuteSchema>;

export async function executeScript(
  args: ExecuteArgs,
  env: Env,
  ctx: ToolContext,
): Promise<unknown> {
  const sdk = buildClientSDK(ctx, env);
  const result = await runScript({
    source: args.script,
    sdk,
    context: {
      organization_id: ctx.organizationId,
      user_id: ctx.userId,
      mode: "execute",
    },
    limits: args.timeout_ms ? { timeoutMs: args.timeout_ms } : undefined,
  });

  return {
    success: result.success,
    return_value: result.returnValue,
    logs: result.logs,
    error: result.error,
    duration_ms: result.durationMs,
    sdk_calls: result.sdkCalls,
  };
}
