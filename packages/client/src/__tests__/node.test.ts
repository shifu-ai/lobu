import { describe, expect, test } from "bun:test";
import { action, defineConnector, Lobu } from "../node.js";

describe("hosted connector helpers", () => {
  test("registers metadata-only connectors", async () => {
    let body: Record<string, unknown> | undefined;
    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      org: "acme",
      token: "token",
      fetch: (async (...args) => {
        body = JSON.parse(String(args[1]?.body)) as Record<string, unknown>;
        return json({ ok: true });
      }) as typeof fetch,
    });

    await lobu.connectors.register(
      defineConnector({
        key: "app.crm",
        name: "CRM",
        version: "1.0.0",
        actions: {
          refund: action({
            key: "refund",
            name: "Refund",
            execute: async () => ({ ok: true }),
          }),
        },
      })
    );

    expect(body?.action).toBe("install_connector");
    expect((body?.connector_definition as { key?: string }).key).toBe(
      "app.crm"
    );
  });

  test("serves action runs through worker endpoints", async () => {
    const controller = new AbortController();
    const completed: Record<string, unknown>[] = [];
    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      org: "acme",
      token: "token",
      fetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/workers/poll")) {
          return json({
            run_id: 7,
            run_type: "action",
            connector_key: "app.crm",
            action_key: "refund",
            action_input: { amount: 10 },
          });
        }
        if (url.endsWith("/api/workers/complete-action")) {
          completed.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>
          );
          controller.abort();
          return json({ success: true });
        }
        throw new Error(`unexpected url ${url}`);
      }) as typeof fetch,
    });

    await lobu.connectors.serve(
      defineConnector({
        key: "app.crm",
        name: "CRM",
        version: "1.0.0",
        actions: {
          refund: action<{ amount: number }>({
            key: "refund",
            name: "Refund",
            execute: async (_ctx, input) => ({ refunded: input.amount }),
          }),
        },
      }),
      { workerId: "worker-1", signal: controller.signal }
    );

    expect(completed).toEqual([
      {
        run_id: 7,
        worker_id: "worker-1",
        status: "success",
        action_output: { refunded: 10 },
      },
    ]);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
