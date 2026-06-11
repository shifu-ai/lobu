process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, expect, test } from "bun:test";
import { generateWorkerToken } from "@lobu/core";
import { Hono } from "hono";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";
import { authenticateWorker } from "../routes/internal/middleware.js";

describe("authenticateWorker", () => {
  test("runs internal handlers inside token organization context", async () => {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "chan-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });

    const app = new Hono();
    app.get("/probe", authenticateWorker, (c) =>
      c.json({ organizationId: tryGetOrgId(), worker: c.get("worker") })
    );

    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizationId).toBe("org-1");
    expect(body.worker.organizationId).toBe("org-1");
  });
});
