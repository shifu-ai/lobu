import type { Context } from "hono";
import { Hono } from "hono";
import { PersonalAccessTokenService } from "../../../auth/tokens.js";
import { getDb } from "../../../db/client.js";
import { orgContext } from "../../../lobu/stores/org-context.js";
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

async function verifyAdminServicePat(c: Context): Promise<"authorized" | "forbidden" | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  if (!token.startsWith("owl_pat_")) return null;

  const authInfo = await new PersonalAccessTokenService(getDb()).verify(token);
  if (!authInfo) return null;

  c.set("mcpAuthInfo" as never, authInfo as never);
  c.set("mcpIsAuthenticated" as never, true as never);
  c.set("organizationId" as never, authInfo.organizationId as never);
  c.set("authSource" as never, "pat" as never);
  c.set(
    "session" as never,
    { id: `pat:${authInfo.clientId}`, userId: authInfo.userId } as never
  );

  return authInfo.scopes.includes("mcp:admin") ? "authorized" : "forbidden";
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

    const patAuth = await verifyAdminServicePat(c);
    if (patAuth === "authorized") {
      const organizationId = (
        c.get("organizationId" as never) as string | null | undefined
      ) ?? null;
      if (organizationId) {
        return orgContext.run({ organizationId }, () => next());
      }
      return next();
    }
    if (patAuth === "forbidden") {
      return c.json(
        {
          success: false,
          error: "Forbidden",
          error_description:
            "Execution task status requires an admin service token.",
        },
        403
      );
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
