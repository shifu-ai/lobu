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
  getStatus?: (taskId: string) => Promise<ExecutionTaskStatusSnapshot | null>;
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
    return createApiAuthMiddleware({
      externalAuthClient: options.externalAuthClient,
      allowSettingsSession: true,
    })(c, next);
  });

  router.get("/api/v1/execution-tasks/:taskId/status", async (c) => {
    const taskId = c.req.param("taskId");
    const status = await (options.getStatus ?? getExecutionTaskStatus)(taskId);
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
