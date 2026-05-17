# @lobu/browser-bridge-mcp — SPIKE

Bridges Lobu connectors to the user's already-signed-in Chrome via
Microsoft's [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
+ the Playwright MCP Bridge Chrome extension
([`mmlmfjhmonkocbjadbfplnigmagldckm`](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm),
MS-published).

This package supersedes the playwriter-based `@lobu/browser-bridge` spike
(PR #819) — see the maintenance writeup there for why. tl;dr: same
architecture, Microsoft-maintained, clean dep tree, no fork-of-Playwright.

## Architecture

```
Lobu worker host (Node)        local MCP HTTP server        MS Bridge ext     user's Chrome
─────────────────────         ────────────────────         ─────────────     ─────────────
MCP client (browser_navigate, ── playwright-mcp        ──  WebSocket  ──    chrome.debugger
            browser_click,...)   --extension --port        client            on user's tabs
                                 (spawned as child)
```

## What this PR proves

| | |
|---|---|
| ✅ MCP bridge server spawn | `startMcpBridgeServer({ port, host })` spawns `playwright-mcp --extension`, waits for HTTP readiness, hands back a clean handle. |
| ✅ MCP client handshake | An `@modelcontextprotocol/sdk` `Client` connects via `StreamableHTTPClientTransport` to `${url}/mcp` and completes the MCP initialize roundtrip. |
| ✅ Expected tool surface | Lists tools and verifies `browser_navigate`, `browser_click`, `browser_snapshot` are advertised. Concrete signal we're talking to playwright-mcp, not a random HTTP server. |
| ✅ Connector-facing API | `acquireBridgeMcp({ bridgeUrl })` wraps the URL composition + handshake into one call for connector authors. |

## What this PR does NOT prove (deferred)

- **Extension install in the user's Chrome.** The MS Playwright Bridge
  extension is on the Chrome Web Store; until the user installs it, tool
  calls (`browser_navigate` etc.) will fail with "no browser connected"
  inside the MCP server. The Mac menu-bar app's "Allow Lobu to use this
  browser" toggle is what should bundle that install — that's the
  next-spike scope.
- **End-to-end with a real attached tab.** Requires the extension above.
  Manual operator verification recipe is in the PR description.
- **Connector authoring story.** Connectors that use this bridge talk MCP
  tools, not the Playwright `Browser`/`Page` API. That's a new authoring
  model for the small subset of connectors that need user's-real-Chrome
  (Revolut, banking). Stays out of this PR; the first such connector will
  flesh the pattern out.
- **Production auth + audit.** The MCP HTTP server binds to loopback by
  default; that's the only security posture. Loopback is not a hard
  security boundary — any local process can reach the port. Production
  needs: random port + capability token in the URL, per-tool consent
  scoping, audit log per call, and the Mac per-profile consent surface.
  Follow-up.
- **Typed connector helpers.** `acquireBridgeMcp` returns a raw MCP
  `Client` today. Connector authors shouldn't have to memorise tool names
  or parse raw tool results long-term — a typed helper layer
  (`navigate(url)`, `snapshot()`, `click(ref)`, `evaluate(...)`) with
  normalised errors (`"extension missing"`, `"no browser attached"`,
  `"tool unavailable"`) is the right level. Stays out of this spike;
  added alongside the first MCP-based connector so the helper shape is
  driven by real usage.
- **Wire into `make build-packages` + publish scripts.** Currently this
  package builds only via its own `bun run build`. Wire it into the
  monorepo build/publish only once the bridge has a first concrete
  consumer (the first MCP-based connector) — until then it's a spike
  artifact, intentionally not on the release path.

## Usage

Server side (typically owned by the Mac menu-bar app or the Lobu gateway):

```ts
import { startMcpBridgeServer } from '@lobu/browser-bridge-mcp';

const bridge = await startMcpBridgeServer({ port: 19998 });
console.log(bridge.url); // http://localhost:19998

// ... later ...
await bridge.close();
```

Connector side:

```ts
import { acquireBridgeMcp } from '@lobu/browser-bridge-mcp';

const { client, close } = await acquireBridgeMcp({
  bridgeUrl: 'http://localhost:19998',
  clientName: 'lobu/revolut-connector',
});
try {
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: 'https://app.revolut.com' },
  });
  const snap = await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  });
  // ... act on snapshot, click, evaluate, ...
} finally {
  await close();
}
```

## Why MCP tool surface instead of Playwright Browser

`@playwright/mcp` exposes an MCP server, not a Playwright endpoint. There
is no JS API to extract a `BrowserContext` connected to the extension —
the `createConnection(config, contextGetter)` factory expects you to
*provide* a context, not receive one. So our wrapper is "spawn the bin in
extension mode and let it own the browser connection."

**Explicit consequence: existing Playwright `Browser`/`Page` connectors
are NOT portable to this bridge as-is.** A bridge connector must be
written (or rewritten) against MCP tools: `browser_navigate(url)`,
`browser_snapshot()`, `browser_click({ ref })`, `browser_evaluate(...)`,
etc. The snapshot model (refs into an accessibility-tree-like structure)
is different from Playwright's locator model. Plan a real rewrite, not a
type-swap.

For Lobu specifically, the connectors that need this bridge are a small
subset (sites that fingerprint or need MFA-trusted sessions — Revolut,
banking). Connectors that don't need the user's real Chrome continue to
use the existing `acquireBrowser` Playwright path in `@lobu/connector-sdk`
against a managed Chromium. Two surfaces, each in its zone of strength.

## Version coupling

`@playwright/mcp` is `0.0.x` and pulls alpha Playwright. We pin the major
range; expected tool names live in `EXPECTED_BROWSER_TOOLS` and the smoke
suite asserts on them. **Treat any `@playwright/mcp` upgrade as
breaking-by-default** — rerun manual e2e (extension install + tool
roundtrip) and update `EXPECTED_BROWSER_TOOLS` if anything moved.

## Manual e2e (operator step)

Until the Mac app handles extension install + per-profile consent:

1. `bunx playwright-mcp --extension --port 19998` (or via this package's
   `startMcpBridgeServer`).
2. Install [Microsoft's Playwright Bridge extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)
   in your Chrome.
3. Click the extension's toolbar icon on a tab to attach.
4. Run an MCP client snippet (e.g. via the `acquireBridgeMcp` example
   above) that calls `browser_navigate` + `browser_snapshot` and verifies
   the snapshot reflects your real browser state.

## License

BUSL-1.1 (Lobu wrapper). Depends on Microsoft's `@playwright/mcp`
(Apache-2.0).
