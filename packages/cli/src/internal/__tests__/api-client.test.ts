import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { ApiClient, resolveApiClient } from "../api-client";
import * as context from "../context";
import * as credentials from "../credentials";

// Mocking filesystem and other dependencies to keep it clean and fast
mock.module("../context", () => ({
  ...context,
  loadContextConfig: mock(),
  resolveContext: mock(),
  findContextByUrl: mock(),
  getActiveOrg: mock(),
}));

mock.module("../credentials", () => ({
  ...credentials,
  getToken: mock(),
  loadCredentials: mock(),
}));

describe("ApiClient", () => {
  test("request sends correct headers", async () => {
    const fetchMock = mock(async (url: string, init: any) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ApiClient(
      "https://api.example.com",
      "my-token",
      fetchMock as any
    );
    const result = await client.get("/test");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/test");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer my-token",
      Accept: "application/json",
    });
  });

  test("request throws ApiClientError on failure", async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ error: "Failed", message: "Error message" }),
        { status: 400 }
      );
    });

    const client = new ApiClient(
      "https://api.example.com",
      "my-token",
      fetchMock as any
    );

    expect(client.get("/fail")).rejects.toThrow(
      "GET /fail failed: Error message"
    );
  });
});

describe("resolveApiClient", () => {
  beforeEach(() => {
    process.env.LOBU_API_TOKEN = "";
    process.env.LOBU_ORG = "";
  });

  test("P1: resolves correct context and token when apiUrl is overridden", async () => {
    const resolveContextMock = context.resolveContext as any;
    const findContextByUrlMock = context.findContextByUrl as any;
    const getTokenMock = credentials.getToken as any;
    const getActiveOrgMock = context.getActiveOrg as any;

    resolveContextMock.mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });

    findContextByUrlMock.mockImplementation(async (url: string) => {
      if (url === "https://custom.lobu.ai/api/v1") {
        return {
          name: "custom",
          apiUrl: "https://custom.lobu.ai/api/v1",
          source: "config",
        };
      }
      return undefined;
    });

    getTokenMock.mockImplementation(async (name: string) => {
      if (name === "custom") return "custom-token";
      if (name === "default") return "default-token";
      return null;
    });

    getActiveOrgMock.mockResolvedValue("my-org");

    // Case 1: Use custom URL that matches a context
    const resolved = await resolveApiClient({
      apiUrl: "https://custom.lobu.ai/api/v1",
    });
    expect(resolved.contextName).toBe("custom");
    expect(resolved.token).toBe("custom-token");
    expect(resolved.apiBaseUrl).toBe("https://custom.lobu.ai");

    // Case 2: Use custom URL that DOES NOT match a context (should fail if not logged in to default or if URLs differ)
    findContextByUrlMock.mockResolvedValue(undefined);
    expect(
      resolveApiClient({ apiUrl: "https://unknown.lobu.ai/api/v1" })
    ).rejects.toThrow("Refusing to send stored context credentials");
  });

  test("P2: resolves correct org slug per context", async () => {
    const resolveContextMock = context.resolveContext as any;
    const getTokenMock = credentials.getToken as any;
    const getActiveOrgMock = context.getActiveOrg as any;

    resolveContextMock.mockResolvedValue({
      name: "prod",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    getTokenMock.mockResolvedValue("prod-token");

    // getActiveOrg should be called with the context name
    getActiveOrgMock.mockImplementation(async (ctx?: string) => {
      if (ctx === "prod") return "prod-org";
      return "default-org";
    });

    const resolved = await resolveApiClient({ context: "prod" });
    expect(resolved.orgSlug).toBe("prod-org");
    expect(getActiveOrgMock).toHaveBeenCalledWith("prod");
  });
});
