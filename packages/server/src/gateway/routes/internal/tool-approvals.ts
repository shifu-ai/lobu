import { Hono } from "hono";
import type {
  ToolApprovalAction,
  ToolApprovalGlobalStatusInput,
  ToolApprovalRevokeGlobalInput,
  ToolApprovalSubmitInput,
  ToolApprovalSubmitResult,
} from "../../auth/mcp/tool-approval-service.js";

type ToolApprovalService = {
  submit(input: ToolApprovalSubmitInput): Promise<ToolApprovalSubmitResult>;
  revokeGlobal(
    input: ToolApprovalRevokeGlobalInput
  ): Promise<{ status: "revoked" } | { status: "forbidden" }>;
  getGlobalStatus(
    input: ToolApprovalGlobalStatusInput
  ): Promise<{ enabled: boolean } | { status: "forbidden" }>;
};

interface ToolApprovalRoutesConfig {
  service: ToolApprovalService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(c: {
  req: { json(): Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function readNonEmptyString(
  body: Record<string, unknown>,
  key: string
): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function invalidRequest(c: { json(body: object, status?: number): Response }) {
  return c.json({ error: "invalid_request" }, 400);
}

function contextValue(c: unknown, key: string): unknown {
  return (c as { get(name: string): unknown }).get(key);
}

function requireAdminPat(c: { json(body: object, status?: number): Response }) {
  const session = contextValue(c, "session") as { id?: string } | null;
  const authSource = contextValue(c, "authSource") as
    | "pat"
    | "session"
    | "oauth"
    | null;
  const authInfo = contextValue(c, "mcpAuthInfo") as
    | { scopes?: string[] }
    | null;
  const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

  if (
    authSource === "pat" &&
    session?.id?.startsWith("pat:") &&
    scopes.includes("mcp:admin")
  ) {
    return null;
  }

  return c.json({ error: "forbidden" }, 403);
}

function organizationIdFromContext(c: unknown): string | null {
  const value = contextValue(c, "organizationId");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const VALID_ACTIONS = new Set<ToolApprovalAction>([
  "approve_once",
  "approve_all",
  "deny",
]);

export function createToolApprovalRoutes(
  config: ToolApprovalRoutesConfig
): Hono {
  const router = new Hono();

  router.post("/:approvalId/submit", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const organizationId = organizationIdFromContext(c);
    if (!organizationId) return c.json({ error: "unauthorized" }, 401);

    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c);

    const action = body.action;
    const toolboxUserId = readNonEmptyString(body, "toolboxUserId");
    const lineUserId = readNonEmptyString(body, "lineUserId");
    const agentId = readNonEmptyString(body, "agentId");
    const approvalId = c.req.param("approvalId")?.trim();

    if (
      typeof action !== "string" ||
      !VALID_ACTIONS.has(action as ToolApprovalAction) ||
      !toolboxUserId ||
      !lineUserId ||
      !agentId ||
      !approvalId
    ) {
      return invalidRequest(c);
    }

    const result = await config.service.submit({
      approvalId,
      action: action as ToolApprovalAction,
      toolboxUserId,
      lineUserId,
      agentId,
      organizationId,
    });
    if (result.status === "forbidden") {
      return c.json(result, 403);
    }
    return c.json(result);
  });

  router.delete("/global-auto-approval", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const organizationId = organizationIdFromContext(c);
    if (!organizationId) return c.json({ error: "unauthorized" }, 401);

    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c);

    const toolboxUserId = readNonEmptyString(body, "toolboxUserId");
    const lineUserId = readNonEmptyString(body, "lineUserId");
    const agentId = readNonEmptyString(body, "agentId");

    if (!toolboxUserId || !lineUserId || !agentId) {
      return invalidRequest(c);
    }

    const result = await config.service.revokeGlobal({
      toolboxUserId,
      lineUserId,
      agentId,
      organizationId,
    });
    if (result.status === "forbidden") {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json(result);
  });

  router.post("/global-auto-approval/status", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const organizationId = organizationIdFromContext(c);
    if (!organizationId) return c.json({ error: "unauthorized" }, 401);

    const body = await readJsonBody(c);
    if (!body) return invalidRequest(c);

    const toolboxUserId = readNonEmptyString(body, "toolboxUserId");
    const agentId = readNonEmptyString(body, "agentId");

    if (!toolboxUserId || !agentId) {
      return invalidRequest(c);
    }

    const result = await config.service.getGlobalStatus({
      toolboxUserId,
      agentId,
      organizationId,
    });
    if ("status" in result && result.status === "forbidden") {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json(result);
  });

  return router;
}
