import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { canonicalize } from "json-canonicalize";
import type { McpToolDef, ReleaseCapabilityState } from "@lobu/core";
import { buildEffectiveToolInventory } from "../openclaw/effective-tool-inventory";

function tool(name: string): McpToolDef {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
  };
}

const ACTIVE: ReleaseCapabilityState = {
  status: "active",
  claim: {
    environment: "production",
    toolboxUserId: "user-1",
    agentId: "agent-1",
    releaseId: "release-7",
    releaseSequence: 7,
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    capabilityIds: [],
  },
};

/**
 * Server-side recompute, verbatim from release-assurance-readback.ts
 * `canonicalToolInventory` (json-canonicalize over sorted unique trimmed
 * names). The gateway rejects the inventory snapshot write when the reported
 * fingerprint differs from this — the 2026-07-20 canary turn 409'd because
 * the worker sent the structural inventory fingerprint instead.
 */
function serverNamesFingerprint(names: readonly string[]): string {
  const canonical = [...new Set(names.map((name) => name.trim()))].sort();
  return createHash("sha256").update(canonicalize(canonical)).digest("hex");
}

describe("effective inventory names fingerprint wire contract", () => {
  test("namesFingerprint matches the gateway's recompute over allowedToolKeys", () => {
    const inventory = buildEffectiveToolInventory({
      scopedTools: {
        beta: [tool("z_tool"), tool("a_tool")],
        alpha: [tool("m_tool")],
      },
      releaseState: ACTIVE,
      connectedMcpIds: ["alpha", "beta"],
      grantedToolKeys: ["alpha/m_tool", "beta/a_tool", "beta/z_tool"],
    });
    expect(inventory.allowedToolKeys.length).toBeGreaterThan(0);
    expect(inventory.namesFingerprint).toBe(
      serverNamesFingerprint(inventory.allowedToolKeys)
    );
    expect(inventory.namesFingerprint).not.toBe(inventory.fingerprint);
    expect(inventory.namesFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
