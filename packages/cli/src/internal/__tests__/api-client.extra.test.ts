import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  ApiClient,
  ApiClientError,
  apiBaseFromContextUrl,
  listOrganizations,
  resolveApiClient,
} from "../api-client";
import * as context from "../context";
import * as credentials from "../credentials";

describe("ApiClient HTTP verb wrappers", () => {
  test("patch sends a PATCH request with JSON body", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    const result = await client.patch<{ ok: boolean }>("/foo", { a: 1 });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/foo");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    });
  });

  test("post sends a POST request with JSON body", async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ ok: true }), { status: 201 })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    const result = await client.post<{ ok: boolean }>("/x", { v: 2 });
    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ v: 2 }));
  });

  test("delete accepts both 200 and 204 status codes (204 returns undefined)", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    const result = await client.delete("/things/1");
    expect(result).toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("DELETE");
  });

  test("delete with 200 returns parsed JSON body", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ deleted: true }), { status: 200 })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    const result = await client.delete<{ deleted: boolean }>("/things/1");
    expect(result).toEqual({ deleted: true });
  });

  test("delete throws when the response status is outside okStatuses", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ message: "nope" }), { status: 403 })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    await expect(client.delete("/forbidden")).rejects.toThrow(
      "DELETE /forbidden failed: nope"
    );
  });

  test("absolute path passes through fetch unchanged", async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({}), { status: 200 })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );
    await client.get("https://other.example.com/abs");
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://other.example.com/abs");
  });

  test("non-JSON error body produces a fallback error message", async () => {
    const fetchMock = mock(
      async () =>
        new Response("server boom", {
          status: 500,
          statusText: "Internal Server Error",
        })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    let caught: ApiClientError | undefined;
    try {
      await client.get("/boom");
    } catch (e) {
      caught = e as ApiClientError;
    }
    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught?.status).toBe(500);
    // parsed error becomes { error: "server boom" }, then extractError uses
    // record.error string
    expect(caught?.message).toBe("GET /boom failed: server boom");
  });

  test("non-JSON success body throws ApiClientError", async () => {
    const fetchMock = mock(
      async () => new Response("not json", { status: 200 })
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    await expect(client.get("/bad-json")).rejects.toThrow(/Invalid JSON/);
  });

  test("error body with nested error object surfaces inner message", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "inner-bad", code: "E_INNER" } }),
          { status: 422 }
        )
    );
    const client = new ApiClient(
      "https://api.example.com",
      "tok",
      fetchMock as unknown as typeof fetch
    );

    let caught: ApiClientError | undefined;
    try {
      await client.get("/oops");
    } catch (e) {
      caught = e as ApiClientError;
    }
    expect(caught?.message).toBe("GET /oops failed: inner-bad");
    expect(caught?.code).toBe("E_INNER");
  });
});

describe("apiBaseFromContextUrl", () => {
  test("strips path, search and hash from a URL", () => {
    expect(apiBaseFromContextUrl("https://app.lobu.ai/api/v1?foo=1#frag")).toBe(
      "https://app.lobu.ai"
    );
  });

  test("preserves a non-default port", () => {
    expect(apiBaseFromContextUrl("http://localhost:8787/api/v1")).toBe(
      "http://localhost:8787"
    );
  });
});

describe("getOrganizationsFromUserInfo (via listOrganizations)", () => {
  beforeEach(() => {
    delete process.env.LOBU_API_TOKEN;
    delete process.env.LOBU_ORG;
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns parsed organizations from /oauth/userinfo", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });

    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            organizations: [
              { slug: "alpha", name: "Alpha Org" },
              { slug: "beta" },
              // skipped: missing slug
              { name: "no-slug" },
              // skipped: not an object
              "garbage",
              null,
            ],
          }),
          { status: 200 }
        )
    );

    const orgs = await listOrganizations({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(orgs).toEqual([
      { slug: "alpha", name: "Alpha Org" },
      { slug: "beta" },
    ]);
  });

  test("returns [] when the userinfo response is non-OK", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });

    const fetchMock = mock(async () => new Response("nope", { status: 500 }));

    const orgs = await listOrganizations({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(orgs).toEqual([]);
  });

  test("returns [] when the response body is not JSON", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });

    const fetchMock = mock(
      async () => new Response("not-json", { status: 200 })
    );

    const orgs = await listOrganizations({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(orgs).toEqual([]);
  });

  test("returns [] when the JSON omits organizations array", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });

    const fetchMock = mock(
      async () => new Response(JSON.stringify({ user: "x" }), { status: 200 })
    );

    const orgs = await listOrganizations({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(orgs).toEqual([]);
  });

  test("uses cached oauth.userinfoEndpoint from credentials when available", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
      oauth: {
        clientId: "id",
        userinfoEndpoint: "https://auth.example.com/userinfo",
      },
    });

    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ organizations: [{ slug: "z" }] }), {
          status: 200,
        })
    );

    const orgs = await listOrganizations({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(orgs).toEqual([{ slug: "z" }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.example.com/userinfo");
  });

  test("listOrganizations throws when no token is available", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue(null);

    await expect(listOrganizations()).rejects.toThrow(/Not logged in/);
  });
});

describe("resolveApiClient org resolution", () => {
  beforeEach(() => {
    delete process.env.LOBU_API_TOKEN;
    delete process.env.LOBU_ORG;
  });

  afterEach(() => {
    mock.restore();
  });

  test("throws when no token can be found", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue(null);

    await expect(resolveApiClient()).rejects.toThrow(/Not logged in/);
  });

  test("LOBU_ORG env var overrides everything else", async () => {
    process.env.LOBU_ORG = "env-org";
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("active-org");

    const resolved = await resolveApiClient();
    expect(resolved.orgSlug).toBe("env-org");
  });

  test("falls back to the single available org from userinfo", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(null);
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ organizations: [{ slug: "only-one" }] }),
          { status: 200 }
        )
    );

    const resolved = await resolveApiClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved.orgSlug).toBe("only-one");
  });

  test("throws when multiple orgs are available and none selected", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(null);
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            organizations: [{ slug: "a" }, { slug: "b" }],
          }),
          { status: 200 }
        )
    );

    await expect(
      resolveApiClient({
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toThrow(/Multiple organizations are available/);
  });

  test("throws when no orgs are returned at all", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(null);
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: "tok",
    });
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ organizations: [] }), { status: 200 })
    );

    await expect(
      resolveApiClient({
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    ).rejects.toThrow(/No organization selected/);
  });

  test("rejects an invalid explicit org slug", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      apiUrl: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(credentials, "getToken").mockResolvedValue("tok");

    await expect(resolveApiClient({ org: "Bad Slug!" })).rejects.toThrow(
      /Invalid organization slug/
    );
  });
});
