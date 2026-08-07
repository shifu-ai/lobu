import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PERSONAL_BROWSER_LOCAL_EGO_CAPABILITY,
  projectBrowserTools,
  releaseCapabilityIdsForBrowserTools,
} from "../openclaw/local-browser-tools";

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
 * 2026-08-07 production incident. The injected system prompt told the agent it
 * had `browser_read_dom` / `browser_screenshot` / `browser_navigate`, but no
 * browser tool was ever registered, so the agent answered "browser_read_dom
 * 工具在目前環境中不可用 ... 這些工具並未載入". That report was accurate and left
 * the user with no way forward.
 *
 * The release claim was fine — every capability snapshot for those turns
 * contained personal_browser.local_ego.v1. The two consumers of that claim
 * simply resolved the agent id differently:
 *
 *   prompt builder   session-context.ts   data.agentId || verifiedToken?.agentId || ""
 *   tool registrar   session-runner.ts    agentId || ""            <-- no fallback
 *
 * releaseCapabilityIdsForBrowserTools rejects on `claim.agentId !== agentId`,
 * so an empty worker-supplied id silently emptied the tool list on one side
 * only.
 */
describe("local browser tools — agent id resolution", () => {
  it("registers all three tools when the resolved id matches the claim", () => {
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

  it("silently registers nothing when the id resolves to the empty string", () => {
    const capabilityIds = releaseCapabilityIdsForBrowserTools({
      releaseState: activeReleaseState(),
      agentId: "",
    });
    expect(capabilityIds).toEqual([]);
    expect(projectBrowserTools({ capabilityIds })).toEqual([]);
  });

  /*
   * The defect lived at the call site, not inside the helper, so a helper-only
   * test cannot catch a regression. runAISession needs a full worker
   * environment and offers no seam, so guard the call sites at the source
   * level instead: both must fall back past their own possibly-empty id.
   */
  it("resolves the same identity on both consumers of the release claim", () => {
    const runner = readFileSync(
      new URL("../openclaw/session-runner.ts", import.meta.url),
      "utf8"
    );
    const context = readFileSync(
      new URL("../openclaw/session-context.ts", import.meta.url),
      "utf8"
    );

    // Registrar: resolves the id inline, at the helper call.
    const registrarCall =
      runner.match(
        /releaseCapabilityIdsForBrowserTools\(\{[\s\S]*?\}\)/
      )?.[0] ?? "";
    expect(registrarCall).toContain("releaseState: context.releaseState");
    expect(
      registrarCall,
      'session-runner.ts must fall back to context.agentId; `agentId || ""` alone silently empties the tool list when the worker param is unset'
    ).toContain("context.agentId");

    // Prompt builder: resolves the id one level up, at its own call site.
    // `releaseState,` without a type annotation distinguishes the invocation
    // from the function declaration above it.
    const promptCall =
      context.match(
        /buildLocalBrowserToolInstructions\(\s*releaseState,[\s\S]*?\);/
      )?.[0] ?? "";
    expect(
      promptCall,
      "session-context.ts must fall back to the verified worker token identity"
    ).toContain("verifiedToken");
  });
});
