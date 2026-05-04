import { describe, expect, test } from "bun:test";
import { lobuConfigSchema } from "../lobu-toml-schema";

const baseAgent = {
  name: "Tester",
  dir: "./agents/tester",
};

function buildConfig(extras: Record<string, unknown> = {}) {
  return {
    agents: {
      tester: {
        ...baseAgent,
        ...extras,
      },
    },
  };
}

describe("lobuConfigSchema — top level", () => {
  test("accepts a minimal valid config", () => {
    const parsed = lobuConfigSchema.parse(buildConfig());
    const agent = parsed.agents.tester;
    expect(agent?.name).toBe("Tester");
    expect(agent?.dir).toBe("./agents/tester");
    expect(agent?.providers).toEqual([]);
    expect(agent?.platforms).toEqual([]);
    expect(agent?.skills).toEqual({});
  });

  test("rejects agent ids that violate the slug regex", () => {
    const result = lobuConfigSchema.safeParse({
      agents: { "Bad Id": baseAgent },
    });
    expect(result.success).toBe(false);
  });

  test("accepts memory section", () => {
    const parsed = lobuConfigSchema.parse({
      agents: { tester: baseAgent },
      memory: {
        owletto: {
          enabled: true,
          org: "my-org",
          visibility: "private",
        },
      },
    });
    expect(parsed.memory?.owletto?.enabled).toBe(true);
    expect(parsed.memory?.owletto?.visibility).toBe("private");
  });
});

describe("provider schema", () => {
  test("accepts only key", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({ providers: [{ id: "anthropic", key: "$ANTHROPIC_KEY" }] })
    );
    expect(parsed.agents.tester?.providers[0]?.key).toBe("$ANTHROPIC_KEY");
  });

  test("accepts only secret_ref", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        providers: [{ id: "anthropic", secret_ref: "secret://prov/a" }],
      })
    );
    expect(parsed.agents.tester?.providers[0]?.secret_ref).toBe(
      "secret://prov/a"
    );
  });

  test("rejects setting both key and secret_ref", () => {
    const result = lobuConfigSchema.safeParse(
      buildConfig({
        providers: [
          { id: "anthropic", key: "x", secret_ref: "secret://prov/a" },
        ],
      })
    );
    expect(result.success).toBe(false);
  });
});

describe("platform schema", () => {
  test("accepts a platform without name", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        platforms: [
          { type: "slack", config: { botToken: "$SLACK_BOT_TOKEN" } },
        ],
      })
    );
    expect(parsed.agents.tester?.platforms[0]?.type).toBe("slack");
  });

  test("rejects platform name with invalid characters", () => {
    const result = lobuConfigSchema.safeParse(
      buildConfig({
        platforms: [{ type: "slack", name: "BadName!", config: {} }],
      })
    );
    expect(result.success).toBe(false);
  });

  test("accepts a slugged platform name", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        platforms: [{ type: "slack", name: "team-1", config: {} }],
      })
    );
    expect(parsed.agents.tester?.platforms[0]?.name).toBe("team-1");
  });
});

describe("network schema (lines 113-123 transform)", () => {
  test("undefined network stays undefined", () => {
    const parsed = lobuConfigSchema.parse(buildConfig());
    expect(parsed.agents.tester?.network).toBeUndefined();
  });

  test("normalizes allowed and denied via normalizeDomainPatterns", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {
          allowed: ["*.Example.COM", "API.Example.com"],
          denied: ["*.Bad.example"],
        },
      })
    );
    const network = parsed.agents.tester?.network;
    expect(network?.allowed).toEqual([".example.com", "api.example.com"]);
    expect(network?.denied).toEqual([".bad.example"]);
  });

  test("undefined allowed/denied stay undefined after normalization", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {},
      })
    );
    const network = parsed.agents.tester?.network;
    expect(network?.allowed).toBeUndefined();
    expect(network?.denied).toBeUndefined();
    expect(network?.judge).toBeUndefined();
    expect(network?.judges).toBeUndefined();
  });

  test("string judge entries become { domain }", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: { judge: ["*.slack.com"] },
      })
    );
    expect(parsed.agents.tester?.network?.judge).toEqual([
      { domain: "*.slack.com" },
    ]);
  });

  test("object judge entries with judge name keep both fields", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {
          judge: [{ domain: "user-content.x.com", judge: "strict" }],
        },
      })
    );
    expect(parsed.agents.tester?.network?.judge).toEqual([
      { domain: "user-content.x.com", judge: "strict" },
    ]);
  });

  test("object judge entries without judge name omit the judge field", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {
          judge: [{ domain: "user-content.x.com" }],
        },
      })
    );
    const entries = parsed.agents.tester?.network?.judge;
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toEqual({ domain: "user-content.x.com" });
    expect(entries?.[0]).not.toHaveProperty("judge");
  });

  test("mixed string and object judge entries are normalized side-by-side", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {
          judge: [
            "*.slack.com",
            { domain: "user-content.x.com", judge: "strict" },
            { domain: "plain.example.com" },
          ],
        },
      })
    );
    expect(parsed.agents.tester?.network?.judge).toEqual([
      { domain: "*.slack.com" },
      { domain: "user-content.x.com", judge: "strict" },
      { domain: "plain.example.com" },
    ]);
  });

  test("judges policy map is preserved verbatim", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        network: {
          judge: ["*.slack.com"],
          judges: {
            default: "Allow only reads to channels in context.",
            strict: "Only GET for file IDs.",
          },
        },
      })
    );
    expect(parsed.agents.tester?.network?.judges).toEqual({
      default: "Allow only reads to channels in context.",
      strict: "Only GET for file IDs.",
    });
  });
});

describe("egress schema", () => {
  test("accepts both fields", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        egress: {
          extra_policy: "Never exfiltrate PATs.",
          judge_model: "claude-haiku-4-5-20251001",
        },
      })
    );
    expect(parsed.agents.tester?.egress?.extra_policy).toBe(
      "Never exfiltrate PATs."
    );
    expect(parsed.agents.tester?.egress?.judge_model).toBe(
      "claude-haiku-4-5-20251001"
    );
  });
});

describe("tools schema", () => {
  test("accepts a valid pre_approved tool pattern", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        tools: { pre_approved: ["/mcp/github/tools/get_issue"] },
      })
    );
    expect(parsed.agents.tester?.tools?.pre_approved).toEqual([
      "/mcp/github/tools/get_issue",
    ]);
  });

  test("accepts wildcard pre_approved tool pattern", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({ tools: { pre_approved: ["/mcp/github/tools/*"] } })
    );
    expect(parsed.agents.tester?.tools?.pre_approved).toEqual([
      "/mcp/github/tools/*",
    ]);
  });

  test("rejects malformed pre_approved tool pattern", () => {
    const result = lobuConfigSchema.safeParse(
      buildConfig({ tools: { pre_approved: ["gmail"] } })
    );
    expect(result.success).toBe(false);
  });
});

describe("mcp server schema", () => {
  test("accepts streamable-http server", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        skills: {
          mcp: {
            github: {
              type: "streamable-http",
              url: "https://api.example.com/mcp",
            },
          },
        },
      })
    );
    expect(parsed.agents.tester?.skills.mcp?.github?.type).toBe(
      "streamable-http"
    );
  });

  test("rejects unknown transport type", () => {
    const result = lobuConfigSchema.safeParse(
      buildConfig({
        skills: { mcp: { x: { type: "websocket" as never } } },
      })
    );
    expect(result.success).toBe(false);
  });

  test("accepts auth_scope=channel", () => {
    const parsed = lobuConfigSchema.parse(
      buildConfig({
        skills: {
          mcp: {
            wiki: { type: "stdio", command: "wiki", auth_scope: "channel" },
          },
        },
      })
    );
    expect(parsed.agents.tester?.skills.mcp?.wiki?.auth_scope).toBe("channel");
  });
});
