import { describe, expect, mock, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto.js";
import { createToolApprovalRoutes } from "../routes/internal/tool-approvals.js";

function createAuthedApp(service: {
  submit: ReturnType<typeof mock>;
  revokeGlobal: ReturnType<typeof mock>;
  getGlobalStatus: ReturnType<typeof mock>;
}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("organizationId", "org-1");
    c.set("authSource", "pat");
    c.set("session", { id: "pat:toolbox" });
    c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
    await orgContext.run({ organizationId: "org-1" }, () => next());
  });
  app.route(
    "/internal/tool-approvals",
    createToolApprovalRoutes({ service })
  );
  return app;
}

describe("LINE tool approval routes", () => {
  test("submits approve_all to the approval service", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    const app = createAuthedApp(service);

    const res = await app.request("/internal/tool-approvals/ta-1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve_all",
        toolboxUserId: "toolbox-user-1",
        lineUserId: "line-user-1",
        agentId: "shifu-u-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "executed" });
    expect(service.submit).toHaveBeenCalledWith({
      approvalId: "ta-1",
      action: "approve_all",
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
      organizationId: "org-1",
    });
  });

  test("rejects invalid submit bodies", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    const app = createAuthedApp(service);

    const res = await app.request("/internal/tool-approvals/ta-1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve_forever",
        toolboxUserId: "toolbox-user-1",
        lineUserId: "line-user-1",
        agentId: "shifu-u-1",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(service.submit).not.toHaveBeenCalled();
  });

  test("revokes global auto-approval", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    const app = createAuthedApp(service);

    const res = await app.request(
      "/internal/tool-approvals/global-auto-approval",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolboxUserId: "toolbox-user-1",
          lineUserId: "line-user-1",
          agentId: "shifu-u-1",
        }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "revoked" });
    expect(service.revokeGlobal).toHaveBeenCalledWith({
      toolboxUserId: "toolbox-user-1",
      lineUserId: "line-user-1",
      agentId: "shifu-u-1",
      organizationId: "org-1",
    });
  });

  test("returns 403 when global auto-approval revoke is forbidden", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "forbidden" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    const app = createAuthedApp(service);

    const res = await app.request(
      "/internal/tool-approvals/global-auto-approval",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolboxUserId: "toolbox-user-wrong",
          lineUserId: "line-user-1",
          agentId: "shifu-u-1",
        }),
      }
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("returns global auto-approval status", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    const app = createAuthedApp(service);

    const res = await app.request(
      "/internal/tool-approvals/global-auto-approval/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolboxUserId: "toolbox-user-1",
          agentId: "shifu-u-1",
        }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
    expect(service.getGlobalStatus).toHaveBeenCalledWith({
      toolboxUserId: "toolbox-user-1",
      agentId: "shifu-u-1",
      organizationId: "org-1",
    });
  });

  test("returns 403 when global auto-approval status is forbidden", async () => {
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ status: "forbidden" })),
    };
    const app = createAuthedApp(service);

    const res = await app.request(
      "/internal/tool-approvals/global-auto-approval/status",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolboxUserId: "toolbox-user-wrong",
          agentId: "shifu-u-1",
        }),
      }
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("rejects non-admin callers", async () => {
    const app = new Hono();
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };
    app.route(
      "/internal/tool-approvals",
      createToolApprovalRoutes({ service })
    );

    const res = await app.request("/internal/tool-approvals/ta-1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "approve_once",
        toolboxUserId: "toolbox-user-1",
        lineUserId: "line-user-1",
        agentId: "shifu-u-1",
      }),
    });

    expect(res.status).toBe(403);
    expect(service.submit).not.toHaveBeenCalled();
  });

  test("does not add internal tool approval routes to public OpenAPI docs", () => {
    const app = new OpenAPIHono();
    const service = {
      submit: mock(async () => ({ status: "executed" })),
      revokeGlobal: mock(async () => ({ status: "revoked" })),
      getGlobalStatus: mock(async () => ({ enabled: true })),
    };

    app.route(
      "/api/v1/internal/tool-approvals",
      createToolApprovalRoutes({ service })
    );
    registerAutoOpenApiRoutes(app);

    const documentedPaths = (
      app.openAPIRegistry.definitions as Array<{
        type: string;
        route?: { path?: string };
      }>
    )
      .filter((definition) => definition.type === "route")
      .map((definition) => definition.route?.path ?? "");

    expect(
      documentedPaths.some((path) =>
        path.startsWith("/api/v1/internal/tool-approvals")
      )
    ).toBe(false);
  });
});
