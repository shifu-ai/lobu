import { beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { createBuiltinSecretRef } from "@lobu/core";
import {
  generatePlaceholder,
  SecretProxy,
  type SecretMapping,
  storeSecretMapping,
} from "../proxy/secret-proxy.js";
import type { SecretStore } from "../secrets/index.js";

describe("storeSecretMapping", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = new MockRedisClient();
  });

  test("stores mapping at expected key", async () => {
    const mapping: SecretMapping = {
      agentId: "agent-1",
      envVarName: "API_KEY",
      secretRef: createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      deploymentName: "deploy-1",
    };
    await storeSecretMapping(redis as any, "test-uuid", mapping);
    const raw = await redis.get("lobu:secret:test-uuid");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.agentId).toBe("agent-1");
    expect(parsed.secretRef).toBe("secret://deployments/agent-1/API_KEY");
  });

  test("uses custom TTL", async () => {
    const mapping: SecretMapping = {
      agentId: "agent-1",
      envVarName: "KEY",
      secretRef: createBuiltinSecretRef("deployments/agent-1/KEY"),
      deploymentName: "deploy-1",
    };
    await storeSecretMapping(redis as any, "uuid-2", mapping, 3600);
    const raw = await redis.get("lobu:secret:uuid-2");
    expect(raw).not.toBeNull();
  });
});

describe("generatePlaceholder", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = new MockRedisClient();
  });

  test("returns placeholder with prefix", async () => {
    const placeholder = await generatePlaceholder(
      redis as any,
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    expect(placeholder).toStartWith("lobu_secret_");
  });

  test("stores mapping in Redis", async () => {
    const placeholder = await generatePlaceholder(
      redis as any,
      "agent-1",
      "API_KEY",
      createBuiltinSecretRef("deployments/agent-1/API_KEY"),
      "deploy-1"
    );
    const uuid = placeholder.replace("lobu_secret_", "");
    const raw = await redis.get(`lobu:secret:${uuid}`);
    expect(raw).not.toBeNull();
    const mapping = JSON.parse(raw!);
    expect(mapping.agentId).toBe("agent-1");
    expect(mapping.envVarName).toBe("API_KEY");
    expect(mapping.secretRef).toBe("secret://deployments/agent-1/API_KEY");
    expect(mapping.deploymentName).toBe("deploy-1");
  });

  test("generates unique placeholders", async () => {
    const p1 = await generatePlaceholder(
      redis as any,
      "a",
      "K",
      createBuiltinSecretRef("deployments/a/K/1"),
      "d"
    );
    const p2 = await generatePlaceholder(
      redis as any,
      "a",
      "K",
      createBuiltinSecretRef("deployments/a/K/2"),
      "d"
    );
    expect(p1).not.toBe(p2);
  });
});

describe("SecretProxy user-scoped provider routing", () => {
  test("passes user context into provider credential lookup", async () => {
    const proxy = new SecretProxy(
      {
        defaultUpstreamUrl: "https://default.example.com",
      },
      {
        get: async () => null,
      } satisfies SecretStore
    );
    const calls: Array<Record<string, string | undefined>> = [];
    let forwardedAuthHeader: string | null = null;
    proxy.registerUpstream(
      {
        slug: "openai",
        upstreamBaseUrl: "https://api.openai.example.com",
      },
      "openai"
    );
    proxy.setAuthProfilesManager({
      getBestProfile: async (agentId, provider, _model, context) => {
        calls.push({
          agentId,
          provider,
          userId: context?.userId,
        });
        return {
          id: "runtime",
          provider,
          credential: "sk-user-scoped",
          authType: "api-key",
          label: "runtime",
          createdAt: Date.now(),
        };
      },
    } as any);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      forwardedAuthHeader =
        (init?.headers as Record<string, string>)?.authorization ?? null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      const res = await proxy
        .getApp()
        .request("/api/proxy/openai/a/agent-1/u/user-42/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "hello" }),
        });

      expect(res.status).toBe(200);
      expect(forwardedAuthHeader).toBe("Bearer sk-user-scoped");
      expect(calls).toEqual([
        {
          agentId: "agent-1",
          provider: "openai",
          userId: "user-42",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
