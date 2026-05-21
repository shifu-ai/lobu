import { describe, expect, test } from "bun:test";
import { Lobu } from "../client.js";

describe("Lobu", () => {
  test("creates a session and sends with the session token", async () => {
    const calls: Array<{
      url: string;
      authorization: string | null;
      body: string;
    }> = [];
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      calls.push(request);

      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }

      return json({
        success: true,
        messageId: "msg_1",
        queued: true,
      });
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu/",
      token: "api-token",
      fetch: fetchImpl,
    });

    const session = await lobu.sessions.create({
      agentId: "support",
      userId: "user_1",
    });
    const result = await session.send("hello", { messageId: "msg_1" });

    expect(session.agentId).toBe("support_user_1");
    expect(result.queued).toBe(true);
    expect(calls[0]).toMatchObject({
      url: "https://lobu.test/lobu/api/v1/agents",
      authorization: "Bearer api-token",
    });
    expect(calls[1]).toMatchObject({
      url: "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
      authorization: "Bearer session-token",
      body: JSON.stringify({ content: "hello", messageId: "msg_1" }),
    });
  });

  test("streams SSE events with authorization", async () => {
    const fetchImpl = (async (input, init) => {
      const request = await requestInfo(input, init);
      if (request.url.endsWith("/api/v1/agents")) {
        return json(
          {
            success: true,
            agentId: "support_user_1",
            token: "session-token",
            expiresAt: Date.now() + 60_000,
            sseUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/events",
            messagesUrl:
              "https://lobu.test/lobu/api/v1/agents/support_user_1/messages",
          },
          201
        );
      }

      expect(request.authorization).toBe("Bearer session-token");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: connected\ndata: {"agentId":"support"}\n\nevent: text\ndata: "hi"\n\n'
              )
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;

    const lobu = new Lobu({
      baseUrl: "https://lobu.test/lobu",
      token: "api-token",
      fetch: fetchImpl,
    });
    const session = await lobu.sessions.create({});
    const events = [];

    for await (const event of session.events()) events.push(event);

    expect(events).toEqual([
      { event: "connected", data: { agentId: "support" }, retry: 3000 },
      { event: "text", data: "hi", retry: 3000 },
    ]);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function requestInfo(
  input: RequestInfo | URL,
  init: RequestInit | undefined
) {
  const request = input instanceof Request ? input : new Request(input, init);
  return {
    url: request.url,
    authorization: request.headers.get("authorization"),
    body: await request.clone().text(),
  };
}
