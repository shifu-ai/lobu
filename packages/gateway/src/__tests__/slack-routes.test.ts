import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSlackRoutes } from "../routes/public/slack.js";

class RouteRedisMock {
  private store = new Map<string, string>();

  async setex(key: string, _ttlSeconds: number, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.store.get(key) ?? null;
    this.store.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        removed++;
      }
    }
    return removed;
  }
}

describe("slack routes", () => {
  const originalClientId = process.env.SLACK_CLIENT_ID;
  const originalScopes = process.env.SLACK_OAUTH_SCOPES;

  let redis: RouteRedisMock;
  let completeSlackOAuthInstall: ReturnType<typeof mock>;
  let handleSlackAppWebhook: ReturnType<typeof mock>;
  let router: ReturnType<typeof createSlackRoutes>;

  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "client-123";
    process.env.SLACK_OAUTH_SCOPES = "chat:write,commands";

    redis = new RouteRedisMock();
    completeSlackOAuthInstall = mock(async () => ({
      teamId: "T123",
      teamName: "Acme",
      connectionId: "conn-1",
    }));
    handleSlackAppWebhook = mock(async (request: Request) => {
      const body = await request.text();
      return new Response(`handled:${body}`);
    });

    router = createSlackRoutes({
      getServices: () => ({
        getQueue: () => ({
          getRedisClient: () => redis,
        }),
        getPublicGatewayUrl: () => "https://gateway.example.com",
      }),
      completeSlackOAuthInstall,
      handleSlackAppWebhook,
    } as any);
  });

  afterEach(() => {
    if (originalClientId === undefined) {
      delete process.env.SLACK_CLIENT_ID;
    } else {
      process.env.SLACK_CLIENT_ID = originalClientId;
    }

    if (originalScopes === undefined) {
      delete process.env.SLACK_OAUTH_SCOPES;
    } else {
      process.env.SLACK_OAUTH_SCOPES = originalScopes;
    }
  });

  test("GET /slack/install redirects to Slack OAuth and stores state", async () => {
    const response = await router.request("/slack/install");

    expect(response.status).toBe(302);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin).toBe("https://slack.com");
    expect(redirectUrl.pathname).toBe("/oauth/v2/authorize");
    expect(redirectUrl.searchParams.get("client_id")).toBe("client-123");
    expect(redirectUrl.searchParams.get("scope")).toBe("chat:write,commands");
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );

    const state = redirectUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const rawState = await redis.get(`slack:oauth:state:${state}`);
    expect(rawState).toBeTruthy();
    expect(JSON.parse(rawState!)).toEqual({
      createdAt: expect.any(Number),
      redirectUri: "https://gateway.example.com/slack/oauth_callback",
    });
  });

  test("GET /slack/oauth_callback rejects invalid state", async () => {
    const response = await router.request(
      "/slack/oauth_callback?code=test-code&state=missing"
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Authentication Failed");
    expect(body).toContain("invalid or has expired");
    expect(completeSlackOAuthInstall).not.toHaveBeenCalled();
  });

  test("GET /slack/oauth_callback completes install and clears state", async () => {
    await redis.setex(
      "slack:oauth:state:test-state",
      600,
      JSON.stringify({
        createdAt: Date.now(),
        redirectUri: "https://gateway.example.com/slack/oauth_callback",
      })
    );

    const response = await router.request(
      "/slack/oauth_callback?code=test-code&state=test-state"
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Slack installed");
    expect(body).toContain("Workspace connected to Lobu:");
    expect(body).toContain("Connection ID: conn-1");
    expect(completeSlackOAuthInstall).toHaveBeenCalledTimes(1);
    expect(completeSlackOAuthInstall.mock.calls[0]?.[1]).toBe(
      "https://gateway.example.com/slack/oauth_callback"
    );
    expect(await redis.get("slack:oauth:state:test-state")).toBeNull();
  });

  test("POST /slack/events forwards requests to the chat manager", async () => {
    const response = await router.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ team_id: "T123", type: "event_callback" }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("handled:");
    expect(handleSlackAppWebhook).toHaveBeenCalledTimes(1);
  });
});
