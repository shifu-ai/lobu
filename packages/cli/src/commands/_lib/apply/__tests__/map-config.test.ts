import { describe, expect, test } from "bun:test";
import {
  defineAgent,
  defineAuthProfile,
  defineConfig,
  defineConnection,
  defineConnector,
  defineEntityType,
  defineRelationshipType,
  defineWatcher,
  secret,
} from "@lobu/sdk";
import { mapProjectToDesiredState } from "../map-config.js";

const env: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-test",
  GH_SECRET: "ghs_test",
};

describe("mapProjectToDesiredState", () => {
  test("maps agents: providers, network (deduped), resolved provider keys", () => {
    const crm = defineAgent({
      id: "crm",
      providers: [
        {
          id: "anthropic",
          model: "claude-sonnet-4-6",
          key: secret("ANTHROPIC_API_KEY"),
        },
      ],
      network: { allowed: ["github.com", "github.com"], denied: ["evil.com"] },
    });
    const state = mapProjectToDesiredState(
      defineConfig({ org: "o", agents: [crm] }),
      env
    );
    const agent = state.agents[0];
    expect(agent?.metadata.agentId).toBe("crm");
    expect(agent?.metadata.name).toBe("crm"); // defaults to id
    expect(agent?.settings.installedProviders?.[0]?.providerId).toBe(
      "anthropic"
    );
    expect(agent?.settings.providerModelPreferences).toEqual({
      anthropic: "claude-sonnet-4-6",
    });
    expect(agent?.settings.networkConfig?.allowedDomains).toEqual([
      "github.com",
    ]);
    expect(agent?.settings.networkConfig?.deniedDomains).toEqual(["evil.com"]);
    expect(agent?.providerKeys).toEqual([
      { providerId: "anthropic", value: "sk-test" },
    ]);
    expect(state.requiredSecrets).toContain("ANTHROPIC_API_KEY");
    expect(state.memory).toEqual({ org: "o" });
  });

  test("maps entities + relationships with typed-handle slugs", () => {
    const person = defineEntityType({ key: "person", name: "Person" });
    const org = defineEntityType({ key: "org" });
    const worksAt = defineRelationshipType({
      key: "works_at",
      rules: [{ source: person, target: org }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({
        agents: [],
        entities: [person, org],
        relationships: [worksAt],
      })
    );
    expect(state.memorySchema.entityTypes.map((e) => e.slug)).toEqual([
      "person",
      "org",
    ]);
    expect(state.memorySchema.relationshipTypes[0]?.rules).toEqual([
      { source: "person", target: "org" },
    ]);
  });

  test("maps watchers: agent handle, sources record, notification", () => {
    const crm = defineAgent({ id: "crm" });
    const watcher = defineWatcher({
      agent: crm,
      slug: "health",
      prompt: "assess",
      extractionSchema: { type: "object" },
      sources: { accounts: "SELECT 1" },
      schedule: "0 */12 * * *",
      notification: { channel: "both", priority: "high" },
      minCooldownSeconds: 1800,
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [crm], watchers: [watcher] })
    );
    const dw = state.watchers[0];
    expect(dw?.agent).toBe("crm");
    expect(dw?.sources).toEqual([{ name: "accounts", query: "SELECT 1" }]);
    expect(dw?.notificationChannel).toBe("both");
    expect(dw?.notificationPriority).toBe("high");
    expect(dw?.minCooldownSeconds).toBe(1800);
  });

  test("throws when a watcher names an unknown agent", () => {
    const watcher = defineWatcher({
      agent: "ghost",
      slug: "x",
      prompt: "p",
      extractionSchema: {},
    });
    expect(() =>
      mapProjectToDesiredState(
        defineConfig({ agents: [], watchers: [watcher] })
      )
    ).toThrow(/ghost/);
  });

  test("maps connections + auth profiles; resolves connector class + secret creds", () => {
    const github = defineConnector({
      key: "github",
      name: "GitHub",
      version: "1.0.0",
      feeds: {
        stars: {
          name: "Stars",
          sync: async () => ({ events: [], checkpoint: null }),
        },
      },
    });
    const auth = defineAuthProfile({
      slug: "gh-app",
      connector: github,
      authKind: "oauth_app",
      credentials: { clientSecret: secret("GH_SECRET") },
    });
    const conn = defineConnection({
      slug: "gh",
      connector: github,
      authProfile: auth,
      feeds: [{ feed: "stars", schedule: "0 */6 * * *" }],
    });
    const state = mapProjectToDesiredState(
      defineConfig({ agents: [], authProfiles: [auth], connections: [conn] }),
      env
    );
    const ap = state.connectors.authProfiles[0];
    expect(ap?.connector).toBe("github"); // class resolved to its key
    expect(ap?.kind).toBe("oauth_app");
    expect(ap?.credentials).toEqual({ clientSecret: "$GH_SECRET" });
    expect(state.requiredSecrets).toContain("GH_SECRET");
    const dc = state.connectors.connections[0];
    expect(dc?.connector).toBe("github");
    expect(dc?.authProfileSlug).toBe("gh-app");
    expect(dc?.feeds).toEqual([{ feedKey: "stars", schedule: "0 */6 * * *" }]);
  });
});
