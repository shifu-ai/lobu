import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";

type AdminHandler = (args: any, env: Env, ctx: ToolContext) => Promise<unknown>;

export function createActionCaller(handler: AdminHandler, env: Env, ctx: ToolContext) {
  const manage = <T>(payload: Record<string, unknown>): Promise<T> =>
    handler(payload as never, env, ctx) as Promise<T>;

  const action = <T>(
    actionName: string,
    input: Record<string, unknown> = {},
  ): Promise<T> => manage({ action: actionName, ...input });

  return { manage, action };
}
