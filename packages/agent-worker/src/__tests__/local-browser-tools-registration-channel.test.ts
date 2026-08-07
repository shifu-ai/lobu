import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY,
  projectBrowserTools,
  releaseCapabilityIdsForBrowserTools,
} from "../openclaw/local-browser-tools";
import { createOpenClawTools } from "../openclaw/tools";

const AGENT_ID = "shifu-u-302b8bcc3af1";

function activeReleaseState() {
  return {
    status: "active" as const,
    claim: {
      agentId: AGENT_ID,
      capabilityIds: [
        "automation.control_plane.v1",
        PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY,
      ],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  } as never;
}

/*
 * 2026-08-07 production incident. The prompt advertised browser_read_dom /
 * browser_screenshot / browser_navigate; every call answered
 * `Tool browser_read_dom not found`.
 *
 * The claim was never at fault — runtime logging proved the identity resolved
 * from `params`, the claim matched, and all three tools were built. They were
 * handed to the session through `tools`, which is the BUILT-IN channel: pi's
 * createAgentSession() uses it only to derive active tool names and rebuilds
 * the base tools itself, after which buildAgentSession() maps over the
 * constructed array swapping in Lobu's instances for OVERRIDABLE_BUILTIN_NAMES.
 * A map can substitute, never add, so a non-builtin routed through `tools`
 * cannot reach the model at all.
 */
describe("local browser tools", () => {
  it("projects all three tools when the claim carries the capability", () => {
    const capabilityIds = releaseCapabilityIdsForBrowserTools({
      releaseState: activeReleaseState(),
      agentId: AGENT_ID,
    });
    expect(projectBrowserTools({ capabilityIds }).map((t) => t.name)).toEqual([
      "browser_read_dom",
      "browser_screenshot",
      "browser_navigate",
    ]);
  });

  it("projects nothing when the claim does not carry the capability", () => {
    expect(
      projectBrowserTools({ capabilityIds: ["calendar.resolve.v1"] })
    ).toEqual([]);
  });

  it("keeps the built-in tool channel free of non-builtin tools", () => {
    const builtinNames = createOpenClawTools("/tmp").map((tool) => tool.name);
    for (const name of [
      "browser_read_dom",
      "browser_screenshot",
      "browser_navigate",
    ]) {
      expect(
        builtinNames,
        `${name} must not ride the built-in channel — pi rebuilds that array and buildAgentSession() can only substitute into it, so the tool would silently vanish`
      ).not.toContain(name);
    }
  });

  /*
   * The defect was a routing choice at the call site, invisible to any unit
   * test of the helpers, and runAISession offers no seam (it needs a full
   * worker environment). Guard the routing at the source level instead.
   */
  it("routes the browser tools through the customTools channel", () => {
    const runner = readFileSync(
      new URL("../openclaw/session-runner.ts", import.meta.url),
      "utf8"
    );

    expect(
      runner,
      "session-runner.ts must push the browser tools onto customTools"
    ).toContain("customTools.push(...localBrowserTools)");

    const builtinConstruction =
      runner.match(/createOpenClawTools\([\s\S]*?\}\)/)?.[0] ?? "";
    expect(
      builtinConstruction,
      "session-runner.ts must not hand the browser tools to the built-in channel"
    ).not.toContain("localBrowserTools");

    const builtins = readFileSync(
      new URL("../openclaw/tools.ts", import.meta.url),
      "utf8"
    );
    expect(
      builtins,
      "createOpenClawTools must not offer a non-builtin injection point that re-opens this bug"
    ).not.toContain("localBrowserTools");
  });
});
