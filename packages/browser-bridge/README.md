# @lobu/browser-bridge — SPIKE

CDP relay that lets Lobu Playwright connectors drive the user's
already-signed-in Chrome via a Chrome extension using `chrome.debugger`.

Status: **spike**. Wraps [`playwriter`](https://github.com/remorses/playwriter)
(MIT) which implements the actual relay + extension. This package gives
connector-sdk a stable Lobu-shaped API so the underlying implementation
can be swapped later (vendored fork, in-house rewrite) without churning
callers.

## Why

Connectors that need the user's real signed-in browser (Revolut, banking,
anything aggressively fingerprinted) can't be driven from a Lobu-launched
Chromium — the site detects it, or the user's MFA/device trust isn't
present. The bridge solves this by attaching to the user's real Chrome via
a `chrome.debugger`-backed extension, while keeping the Lobu Playwright
connector code unchanged: connectors still call `chromium.connectOverCDP`,
the URL just happens to point at the bridge.

See `project_openclaw_browser_plugin.md` in agent memory for the full
landscape (termos prior art, playwright-crx alternative, why the bridge
shim path was picked).

## Architecture

```
Lobu worker host (Node)          local relay          Chrome extension      user's Chrome
─────────────────────           ─────────────         ──────────────       ──────────────
chromium.connectOverCDP(url) ── WS server :19988 ──   WS client            chrome.debugger
                                + browser-level                            on user's tabs
                                CDP shim (Target.*)
```

The shim is what makes `connectOverCDP` work over `chrome.debugger`: it
fakes the browser-level CDP commands (`Target.getTargets`,
`Target.attachToTarget`, etc.) that Playwright expects, translating them
into per-tab `chrome.debugger.attach` calls inside the extension.

## Usage

```ts
import { startBridgeServer } from '@lobu/browser-bridge';
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';

const token = randomBytes(32).toString('hex');
const bridge = await startBridgeServer({ token });

try {
  // bridge.url already contains the /cdp path and ?token=... query.
  // Do NOT pass an Authorization Bearer header — the underlying relay's
  // /cdp route only checks the query token.
  const browser = await chromium.connectOverCDP(bridge.url);
  const page = (await browser.contexts())[0].pages()[0];
  await page.goto('https://app.revolut.com');
  // ... your existing Playwright connector code, unchanged ...
  await browser.close(); // disconnects CDP only — does NOT close user's Chrome.
} finally {
  bridge.close();
}
```

Through `acquireBrowser` (recommended for connectors):

```ts
import { acquireBrowser } from '@lobu/connector-sdk';

const { browser, page } = await acquireBrowser({
  bridgeUrl: bridge.url,
  cookies: [],
  authDomains: [],
});
```

## Cost of taking this dep

Any consumer of `@lobu/browser-bridge` pays the full `playwriter` install
cost (~10 MB unpacked, ~100 transitive packages including hono,
`@xmorse/playwright-core`, the MCP SDK, and a couple of native-binding
optionals). Worth knowing before importing this into a hot path or a
client-side bundle. For server-side connector use this is fine; it's the
same magnitude as Playwright itself.

## What's in / out of scope for this spike PR

In scope:

- The `@lobu/browser-bridge` package wrapping `playwriter`.
- A `bridge` resolution mode in `acquireBrowser` (connector-sdk).
- A wire-level smoke test that proves the relay boots and exposes the CDP
  discovery endpoint Playwright's `connectOverCDP` first hits.

Out of scope (follow-ups):

- The extension itself. For now, load `playwriter`'s unpacked extension
  manually (see `playwriter` docs). A later PR will fold a Lobu-branded
  extension into `apps/chrome/` in the owletto-web submodule.
- The Mac menu-bar "Use my Chrome" toggle and per-profile capability gates.
- Device-pinning UI changes in the connections admin (the existing
  `device_worker_id` primitive is the routing path).
- Production-grade auth and audit: token rotation, per-session caps,
  per-attach consent UI, audit-log emission on session open/close.
- End-to-end test against a real Chrome (manual for the spike; needs a
  Chrome with the extension loaded plus a Playwright snippet).
- Origin-header rejection on the bridge WS (playwriter's auth model is
  token-based; Origin validation is part of its extension story).
- Wiring this package into `make build-packages` and the publish scripts.
  The spike doesn't ship via the normal release flow — it's installable as
  a workspace dep only — until the extension story lands and we know
  whether the public surface stays this small.

## Verification — what's proven, what's blocked

Automated (passing in smoke tests):

- Bridge starts via `startBridgeServer`, listens on the configured loopback port.
- `bridge.url` is shaped correctly: `ws://host:port/cdp[?token=...]`.
- `/cdp` route's token query-param auth gate works (401 without, !401 with).
- playwriter's `/json/version` discovery URL still points at `/cdp`
  (drift check for future upstream releases).
- `chromium.connectOverCDP(bridge.url)` reaches the relay end-to-end — the
  relay accepts the WS upgrade and either pairs the client to an attached
  extension or cleanly rejects with no-extension (verified with no
  extension loaded).

Verified manually via a throwaway Chrome (Playwright `launchPersistentContext`
+ `--load-extension`) + service-worker `evaluate("toggleExtensionForActiveTab()")`:

- Extension connects to `ws://.../extension`, the relay registers it,
  `globalThis.toggleExtensionForActiveTab()` (exposed by playwriter's bg
  script) triggers `chrome.debugger.attach` on the active tab, and the
  relay forwards `Target.attachedToTarget` events to Playwright clients.

Blocked at the moment (NOT a bug in this wrapper):

- After extension attach succeeds, `chromium.connectOverCDP(bridge.url)`
  hangs at the CDP-shim handshake for 30s and times out. Reproduces
  identically against playwriter's relay **without** this wrapper, with
  both `patchright` and `playwright-vanilla`, and `playwriter browser list`
  also fails to see the connected extension. Issue is in `playwriter@0.1.0`
  on npm, not in this wrapper or in our acquireBrowser hook.

  Follow-ups: vendor playwriter from the github main branch (currently
  ~0.1.6, but it's a pnpm workspace with internal deps so `bun add` from
  github can't resolve it cleanly) OR switch the underlying implementation
  to Microsoft's [Playwright MCP Bridge](https://github.com/microsoft/playwright-mcp)
  or [ruifigueira/playwright-crx](https://github.com/ruifigueira/playwright-crx)
  before depending on this in any real connector.

## License

BUSL-1.1 (Lobu wrapper).

### Third-party attribution

This package depends on [`playwriter`](https://github.com/remorses/playwriter)
by Tommaso De Rossi (`xmorse`). Playwriter is distributed under the MIT
License (LICENSE file in the playwriter repo; the npm `license` field is
empty but the source LICENSE is MIT). Source review and security audit of
the playwriter dependency tree is a prerequisite before any production use
of this bridge — the relay grants control of the user's signed-in browser
and pulls in ~100 transitive packages including native binding optionals.
