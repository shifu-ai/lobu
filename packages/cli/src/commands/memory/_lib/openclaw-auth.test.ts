import { describe, expect, test } from "bun:test";
import { getSessionForOrg } from "./openclaw-auth.js";

describe("memory auth URL resolution", () => {
  test("getSessionForOrg honors an explicit --url", async () => {
    const session = await getSessionForOrg(
      "dev",
      undefined,
      "http://localhost:8801"
    );
    expect(session?.key).toBe("http://localhost:8801/mcp/dev");
  });
});
