import { Hono } from "hono";
import type { Env } from "../index";
import { requireAdminPat } from "./provisioning-auth.js";
import {
  readRuntimeReadModelEvents,
  RuntimeReadModelValidationError,
} from "./runtime-read-model-export.js";

export function createRuntimeReadModelRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/agents/:agentId/runtime-read-model-events", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const organizationId = c.get("organizationId") as string | null;
    if (!organizationId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const rawLimit = c.req.query("limit");
    try {
      return c.json(
        await readRuntimeReadModelEvents({
          organizationId,
          agentId: c.req.param("agentId")?.trim() ?? "",
          from: c.req.query("from") ?? "",
          to: c.req.query("to") ?? "",
          limit: rawLimit === undefined ? Number.NaN : Number(rawLimit),
          cursor: c.req.query("cursor") || undefined,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof RuntimeReadModelValidationError) {
        return c.json({ error: error.code }, 400);
      }
      throw error;
    }
  });

  return routes;
}
