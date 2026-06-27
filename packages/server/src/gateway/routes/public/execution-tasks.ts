import type { Context } from "hono";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../../auth/api-auth-middleware.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import {
  getExecutionTaskStatus,
  type ExecutionTaskStatusSnapshot,
} from "../../execution/execution-events.js";

interface ExecutionTaskStatusRoutesOptions {
  externalAuthClient?: ExternalAuthClient;
  authorize?: (c: Context) => Promise<boolean>;
  getStatus?: (
    taskId: string,
    options: { afterEventId?: number; limit?: number }
  ) => Promise<ExecutionTaskStatusSnapshot | null>;
}

function hasAdminServiceScope(c: Context): boolean {
  const authSource = c.get("authSource" as never) as string | undefined;
  const session = c.get("session" as never) as { id?: string } | null;
  const authInfo = c.get("mcpAuthInfo" as never) as {
    scopes?: string[];
  } | null;
  const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

  return (
    authSource === "pat" &&
    typeof session?.id === "string" &&
    session.id.startsWith("pat:") &&
    scopes.includes("mcp:admin")
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function createExecutionTaskStatusRoutes(
  options: ExecutionTaskStatusRoutesOptions = {}
): Hono {
  const router = new Hono();

  router.use("/api/v1/execution-tasks/*", async (c, next) => {
    if (options.authorize) {
      if (!(await options.authorize(c))) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      return next();
    }

    if (hasAdminServiceScope(c)) {
      return next();
    }

    let authenticated = false;
    const authResponse = await createApiAuthMiddleware({
      externalAuthClient: options.externalAuthClient,
      allowSettingsSession: true,
    })(c, async () => {
      authenticated = true;
    });
    if (!authenticated) {
      return authResponse;
    }
    return c.json(
      {
        success: false,
        error: "Forbidden",
        error_description:
          "Execution task status requires an admin service token.",
      },
      403
    );
  });

  router.get("/api/v1/execution-tasks/:taskId/status", async (c) => {
    const taskId = c.req.param("taskId");
    const requestedLimit = parsePositiveInteger(c.req.query("limit"));
    const limit =
      requestedLimit === undefined ? undefined : Math.min(requestedLimit, 200);
    const afterEventId = parsePositiveInteger(c.req.query("afterEventId"));
    const status = await (options.getStatus ?? getExecutionTaskStatus)(taskId, {
      afterEventId,
      limit,
    });
    if (!status) {
      return c.json(
        { success: false, error: "Execution task not found" },
        404
      );
    }
    return c.json({ success: true, task: status });
  });

  return router;
}
