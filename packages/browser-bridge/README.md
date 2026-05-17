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
  const browser = await chromium.connectOverCDP(bridge.url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const page = (await browser.contexts())[0].pages()[0];
  await page.goto('https://app.revolut.com');
  // ... your existing Playwright connector code, unchanged ...
  await browser.close();
} finally {
  bridge.close();
}
```

Through `acquireBrowser` (recommended for connectors):

```ts
import { acquireBrowser } from '@lobu/connector-sdk';

const { browser, page } = await acquireBrowser({
  bridgeUrl: bridge.url,
  bridgeAuthToken: token,
  cookies: [],
  authDomains: [],
});
```

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

## Manual verification

Until the e2e harness exists, the bridge is verified end-to-end by:

1. `bunx playwriter mcp` (or `playwriter cli`) to launch their bundled
   relay + auto-install the extension into Chrome.
2. Run a connector with `cdpUrl` set to `ws://127.0.0.1:19988` (the
   playwriter default).
3. Connector should drive the active tab in your real Chrome.

This package replaces step 1 with `startBridgeServer({ token })` — the
extension half stays manual until the follow-up.

## License

BUSL-1.1 (Lobu wrapper). The underlying `playwriter` package is MIT —
see its repository for attribution.
