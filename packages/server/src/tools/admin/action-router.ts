import { getRequiredAccessLevel } from '../../auth/tool-access';
import logger from '../../utils/logger';
import { enforceRoleScopeAccess, isSystemContext } from '../access-control';
import type { ToolContext } from '../registry';

/**
 * Routes admin tool actions to handler functions with standardized error wrapping.
 *
 * Usage:
 *   return routeAction('manage_entity', args.action, ctx, {
 *     create: () => handleCreate(args, env, ctx),
 *     update: () => handleUpdate(id, args, env, ctx),
 *     list: () => handleList(args, env, ctx),
 *   });
 */
function enforceActionAccess(toolName: string, action: string, ctx: ToolContext): void {
  // Watcher reactions and other in-process system calls historically run with
  // userId=null + isAuthenticated=true. Preserve that path while enforcing the
  // policy table for real user/OAuth sessions that reach handlers via run / query.
  if (isSystemContext(ctx)) return;

  const requiredAccess = getRequiredAccessLevel(toolName, { action }, false);
  enforceRoleScopeAccess(requiredAccess, ctx.memberRole, ctx.scopes, {
    adminRole: `Action ${toolName}.${action} requires admin or owner access. Ask an organization owner to grant elevated access.`,
    writeRole: `Action ${toolName}.${action} requires workspace membership with write access.`,
    readScope: `Action ${toolName}.${action} requires an MCP session with read access.`,
    writeScope: `Action ${toolName}.${action} requires an MCP session with write access.`,
    adminScope: `Action ${toolName}.${action} requires an MCP session with admin access.`,
  });
}

export async function routeAction<TResult>(
  toolName: string,
  action: string,
  ctx: ToolContext,
  handlers: Record<string, () => Promise<TResult>>
): Promise<TResult> {
  const handler = handlers[action];
  if (!handler) {
    throw new Error(`Unknown action: ${action}`);
  }

  enforceActionAccess(toolName, action, ctx);

  try {
    return await handler();
  } catch (error) {
    logger.error(
      {
        error,
        error_message: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined,
      },
      `${toolName} error:`
    );
    throw error;
  }
}

/**
 * Requires a field to be present, throwing a descriptive error if missing.
 * Common pattern for requiring entity_id, watcher_id, etc. per action.
 */
export function requireField<T>(value: T | undefined | null, fieldName: string, action: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${fieldName} is required for ${action} action`);
  }
  return value;
}
