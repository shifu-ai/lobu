import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLobuToml, initCommand } from "../commands/init";

describe("init memory scaffolding", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "lobu-init-memory-"));
    mkdirSync(join(projectDir, "agents", "support"), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("generateLobuToml inlines the [memory] fields when enabled", async () => {
    await generateLobuToml(projectDir, {
      agentName: "support",
      allowedDomains: "github.com,.github.com",
      includeLobuMemory: true,
      lobuOrg: "support",
      lobuName: "Support",
      lobuDescription: "Help support teams",
    });

    const content = readFileSync(join(projectDir, "lobu.toml"), "utf-8");

    expect(content).toContain("[memory]");
    expect(content).toContain('org = "support"');
    expect(content).toContain('name = "Support"');
    expect(content).toContain('description = "Help support teams"');
    expect(content).toContain('models = "./models"');
    expect(content).toContain('data = "./data"');
    expect(content).not.toContain("lobu.yaml");
    expect(existsSync(join(projectDir, "lobu.yaml"))).toBe(false);
  });

  test("generateLobuToml falls back to the agent name when org/name are omitted", async () => {
    await generateLobuToml(projectDir, {
      agentName: "support",
      allowedDomains: "github.com",
      includeLobuMemory: true,
    });

    const content = readFileSync(join(projectDir, "lobu.toml"), "utf-8");

    expect(content).toContain('org = "support"');
    expect(content).toContain('name = "Support"');
  });

  test("init --yes writes empty env entries for generated provider and platform refs", async () => {
    await initCommand(projectDir, "my-agent", {
      yes: true,
      provider: "openrouter",
      platform: "slack",
      memory: "lobu-cloud",
      noSentry: true,
    });

    const env = readFileSync(join(projectDir, "my-agent", ".env"), "utf-8");
    const toml = readFileSync(
      join(projectDir, "my-agent", "lobu.toml"),
      "utf-8"
    );

    expect(toml).toContain('key = "$OPENROUTER_API_KEY"');
    expect(toml).toContain('botToken = "$SLACK_BOT_TOKEN"');
    expect(toml).toContain('signingSecret = "$SLACK_SIGNING_SECRET"');
    expect(env).toContain("OPENROUTER_API_KEY=");
    expect(env).toContain("SLACK_BOT_TOKEN=");
    expect(env).toContain("SLACK_SIGNING_SECRET=");
  });
});
