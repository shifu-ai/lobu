import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  callLocalBrowserTool,
  projectBrowserTools,
} from "../openclaw/local-browser-tools";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("projectBrowserTools", () => {
  test("fails closed without the local ego browser release capability", () => {
    expect(projectBrowserTools({ capabilityIds: [] })).toEqual([]);
  });

  test("projects local ego browser tools for released agents", () => {
    expect(
      projectBrowserTools({
        capabilityIds: ["personal_browser.local_ego.v1"],
      }).map((tool) => tool.name)
    ).toEqual(["browser_read_dom", "browser_screenshot", "browser_navigate"]);
  });
});

describe("callLocalBrowserTool", () => {
  test("calls the Lobu local ego browser tool gateway route", async () => {
    let capturedUrl = "";
    let capturedAuthorization = "";
    let capturedBody: unknown;

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl =
          typeof input === "string" ? input : (input as Request).url;
        capturedAuthorization =
          new Headers(init?.headers).get("authorization") ?? "";
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          text: "Course dashboard\nRevenue, students, next actions",
        });
      }
    ) as unknown as typeof fetch;

    const result = await callLocalBrowserTool({
      // Shaped like the real DISPATCHER_URL, which already carries the /lobu
      // mount. The previous fixture dropped it and let the implementation
      // double-prefix the path unnoticed; production answered a bare 404.
      gatewayUrl: "https://lobu.test/lobu",
      workerToken: "worker-token",
      toolName: "browser_read_dom",
      args: {},
    });

    expect(result.text).toContain("Course dashboard");
    expect(capturedUrl).toBe(
      "https://lobu.test/lobu/api/browser/local-ego/tools/browser_read_dom"
    );
    expect(capturedAuthorization).toBe("Bearer worker-token");
    expect(capturedBody).toEqual({ arguments: {} });
  });
});
