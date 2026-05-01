import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  loadContextConfig,
  getActiveOrg,
  setActiveOrg,
  resolveContext,
  findContextByUrl,
  DEFAULT_CONTEXT_NAME,
} from "../context";
import { readFile, writeFile, mkdir } from "node:fs/promises";

mock.module("node:fs/promises", () => ({
  readFile: mock(),
  writeFile: mock(),
  mkdir: mock(),
}));

describe("context management", () => {
  const readFileMock = readFile as any;
  const writeFileMock = writeFile as any;

  beforeEach(() => {
    readFileMock.mockClear();
    writeFileMock.mockClear();
  });

  test("loadContextConfig handles missing file", async () => {
    readFileMock.mockRejectedValue(new Error("File not found"));
    const config = await loadContextConfig();
    expect(config.currentContext).toBe(DEFAULT_CONTEXT_NAME);
    expect(config.contexts[DEFAULT_CONTEXT_NAME]).toBeDefined();
  });

  test("P2: getActiveOrg and setActiveOrg use context scoping", async () => {
    const configData = {
      currentContext: "prod",
      contexts: {
        lobu: {
          apiUrl: "https://app.lobu.ai/api/v1",
          activeOrg: "default-org",
        },
        prod: { apiUrl: "https://prod.lobu.ai/api/v1", activeOrg: "prod-org" },
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(configData));

    expect(await getActiveOrg("lobu")).toBe("default-org");
    expect(await getActiveOrg("prod")).toBe("prod-org");

    // Test currentContext default
    expect(await getActiveOrg()).toBe("prod-org");
  });

  test("P2: Migration from legacy top-level activeOrg", async () => {
    const legacyData = {
      currentContext: "lobu",
      activeOrg: "legacy-org",
      contexts: {
        lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(legacyData));

    const config = await loadContextConfig();
    expect(config.contexts["lobu"]?.activeOrg).toBe("legacy-org");
  });

  test("P1: findContextByUrl finds matching context", async () => {
    const configData = {
      currentContext: "lobu",
      contexts: {
        lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
        custom: { apiUrl: "https://custom.lobu.ai/api/v1" },
      },
    };
    readFileMock.mockResolvedValue(JSON.stringify(configData));

    const matched = await findContextByUrl("https://custom.lobu.ai/api/v1/"); // with trailing slash
    expect(matched?.name).toBe("custom");
    expect(matched?.apiUrl).toBe("https://custom.lobu.ai/api/v1");

    const none = await findContextByUrl("https://unknown.ai");
    expect(none).toBeUndefined();
  });
});
