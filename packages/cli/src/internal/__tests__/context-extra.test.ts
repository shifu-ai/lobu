import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import {
  addContext,
  DEFAULT_CONTEXT_NAME,
  DEFAULT_MEMORY_URL,
  findContextByMemoryUrl,
  findContextByUrl,
  getCurrentContextName,
  getMemoryUrl,
  resolveContext,
  setActiveOrg,
  setCurrentContext,
  setMemoryUrl,
} from "../context";

describe("context (extra coverage)", () => {
  let readFileSpy: ReturnType<typeof spyOn<typeof fs, "readFile">>;
  let writeFileSpy: ReturnType<typeof spyOn<typeof fs, "writeFile">>;

  beforeEach(() => {
    delete process.env.LOBU_CONTEXT;
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_URL;
    delete process.env.LOBU_MEMORY_URL;

    readFileSpy = spyOn(fs, "readFile");
    writeFileSpy = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    spyOn(fs, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    mock.restore();
  });

  describe("getCurrentContextName", () => {
    test("returns LOBU_CONTEXT env var when set", async () => {
      process.env.LOBU_CONTEXT = "from-env";
      readFileSpy.mockRejectedValue(new Error("ENOENT"));

      const name = await getCurrentContextName();

      expect(name).toBe("from-env");
    });

    test("falls back to the configured currentContext when env unset", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "saved",
          contexts: { saved: { apiUrl: "https://saved.example.com/api/v1" } },
        })
      );

      const name = await getCurrentContextName();

      expect(name).toBe("saved");
    });
  });

  describe("getActiveOrg env override", () => {
    test("returns LOBU_ORG over the stored value", async () => {
      process.env.LOBU_ORG = "env-org";
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: {
            lobu: { apiUrl: "https://app.lobu.ai/api/v1", activeOrg: "stored" },
          },
        })
      );

      const { getActiveOrg } = await import("../context");
      expect(await getActiveOrg()).toBe("env-org");
    });
  });

  describe("getMemoryUrl", () => {
    test("respects LOBU_MEMORY_URL and trims trailing slashes", async () => {
      process.env.LOBU_MEMORY_URL = "https://memory.example.com/mcp///";

      const url = await getMemoryUrl();

      expect(url).toBe("https://memory.example.com/mcp");
    });

    test("uses the per-context memory URL when set", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: {
            lobu: {
              apiUrl: "https://app.lobu.ai/api/v1",
              memoryUrl: "https://stored.example.com/mcp/",
            },
          },
        })
      );

      expect(await getMemoryUrl()).toBe("https://stored.example.com/mcp");
    });

    test("falls back to the default memory URL", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      expect(await getMemoryUrl()).toBe(DEFAULT_MEMORY_URL);
    });
  });

  describe("setActiveOrg validation", () => {
    test("rejects empty slugs", async () => {
      await expect(setActiveOrg("   ")).rejects.toThrow(
        "Organization slug cannot be empty"
      );
    });

    test("rejects slugs with disallowed characters", async () => {
      await expect(setActiveOrg("Bad Slug")).rejects.toThrow(
        /Invalid organization slug/
      );
    });

    test("rejects unknown contexts", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      await expect(setActiveOrg("ok-slug", "missing")).rejects.toThrow(
        'Unknown context "missing"'
      );
    });
  });

  describe("setMemoryUrl", () => {
    test("rejects empty memory URLs", async () => {
      await expect(setMemoryUrl("   ")).rejects.toThrow(
        "Memory URL cannot be empty"
      );
    });

    test("rejects unknown contexts", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      await expect(
        setMemoryUrl("https://memory.example.com/mcp", "missing")
      ).rejects.toThrow('Unknown context "missing"');
    });

    test("normalizes the stored memory URL", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      await setMemoryUrl("https://memory.example.com/mcp/");

      const written = JSON.parse(writeFileSpy.mock.calls[0]![1] as string) as {
        contexts: Record<string, { memoryUrl?: string }>;
      };
      expect(written.contexts.lobu?.memoryUrl).toBe(
        "https://memory.example.com/mcp"
      );
    });
  });

  describe("resolveContext", () => {
    test("env LOBU_API_URL takes precedence", async () => {
      process.env.LOBU_API_URL = "https://override.example.com/api/v1/";
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      const result = await resolveContext();

      expect(result.source).toBe("env");
      expect(result.apiUrl).toBe("https://override.example.com/api/v1");
    });

    test("returns config-source for non-default named contexts", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "prod",
          contexts: {
            prod: { apiUrl: "https://prod.example.com/api/v1" },
          },
        })
      );

      const result = await resolveContext("prod");

      expect(result.source).toBe("config");
      expect(result.apiUrl).toBe("https://prod.example.com/api/v1");
    });

    test("throws when the requested context is not configured", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      await expect(resolveContext("missing")).rejects.toThrow(
        'Unknown context "missing"'
      );
    });
  });

  describe("addContext", () => {
    test("rejects empty names", async () => {
      await expect(
        addContext("   ", "https://api.example.com")
      ).rejects.toThrow("Context name cannot be empty");
    });

    test("rejects invalid API URLs", async () => {
      await expect(addContext("dev", "   ")).rejects.toThrow(
        "API URL cannot be empty"
      );
      await expect(addContext("dev", "not-a-url")).rejects.toThrow(
        "Invalid API URL"
      );
    });

    test("normalizes the stored API URL", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({ currentContext: "lobu", contexts: {} })
      );

      const config = await addContext("dev", "https://dev.example.com/api/v1/");

      expect(config.contexts.dev?.apiUrl).toBe(
        "https://dev.example.com/api/v1"
      );
    });
  });

  describe("setCurrentContext", () => {
    test("rejects empty names", async () => {
      await expect(setCurrentContext("   ")).rejects.toThrow(
        "Context name cannot be empty"
      );
    });

    test("rejects unknown contexts", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      await expect(setCurrentContext("missing")).rejects.toThrow(
        'Unknown context "missing"'
      );
    });

    test("persists the new current context", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: {
            lobu: { apiUrl: "https://app.lobu.ai/api/v1" },
            prod: { apiUrl: "https://prod.example.com/api/v1" },
          },
        })
      );

      const config = await setCurrentContext("prod");

      expect(config.currentContext).toBe("prod");
    });
  });

  describe("normalization edge cases via loadContextConfig", () => {
    test("ignores entries with non-string apiUrl and falls back currentContext when invalid", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "missing",
          contexts: {
            broken: { apiUrl: 42 },
            ok: { apiUrl: "https://ok.example.com/api/v1" },
          },
        })
      );

      // currentContext "missing" doesn't exist after normalization, so we
      // fall back to DEFAULT_CONTEXT_NAME ("lobu") which is always added.
      const name = await getCurrentContextName();
      expect(name).toBe(DEFAULT_CONTEXT_NAME);
    });
  });

  describe("findContextByUrl / findContextByMemoryUrl", () => {
    test("findContextByUrl returns undefined for non-matching URL", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      expect(
        await findContextByUrl("https://nope.example.com/api/v1")
      ).toBeUndefined();
    });

    test("findContextByMemoryUrl matches based on the default memory URL", async () => {
      readFileSpy.mockResolvedValue(
        JSON.stringify({
          currentContext: "lobu",
          contexts: { lobu: { apiUrl: "https://app.lobu.ai/api/v1" } },
        })
      );

      const matched = await findContextByMemoryUrl(DEFAULT_MEMORY_URL);

      expect(matched?.name).toBe("lobu");
      expect(matched?.source).toBe("default");
    });
  });
});
