/**
 * Browser Acquisition
 *
 * Single entry point for all browser-based connectors. Implements a cascade:
 *
 *   1. Bridge — when `bridgeUrl` is set, the connector drives the user's
 *      real signed-in Chrome through @lobu/browser-bridge (a CDP relay
 *      backed by a chrome.debugger extension). Used for sites that need
 *      the user's actual MFA-trusted session — Revolut, banking, etc.
 *      Connects via Playwright's connectOverCDP through the bridge URL.
 *
 *   2. CDP — connect to user's real Chrome via raw CDP protocol.
 *      Uses CdpPage for DOM scraping (avoids Playwright's connectOverCDP crash
 *      on browsers with many tabs). For network interception, callers use
 *      Playwright's connectOverCDP on the resolved wsUrl directly.
 *
 *   3. Playwright — launch headless browser, inject stored cookies.
 *      Cookies may come from a previous CDP session (freshest) or CLI capture.
 *
 * All paths share the same caller API. Fresh cookies are always captured
 * from the resulting context so the caller can persist them for future fallback.
 */

import type { Browser, BrowserContext, Cookie, Page } from 'playwright';
import { sdkLogger } from '../logger.js';
import { resolveCdpUrl } from './cdp.js';
import { CdpPage } from './cdp-page.js';
import { launchBrowser } from './launcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcquireBrowserOptions {
  /**
   * @lobu/browser-bridge endpoint that fronts the user's real signed-in
   * Chrome (via the chrome.debugger-backed extension). When set, takes
   * precedence over `cdpUrl` and `userDataDir`.
   *
   * Pass the URL returned by `BridgeServer.url` directly — it already
   * contains the `/cdp` path and `?token=...` query for auth. Do NOT
   * pass a Bearer header; the underlying relay only checks the query
   * token on its CDP route.
   *
   * Used for connectors against sites that need the user's real
   * MFA-trusted session — Revolut, banking, etc. — where a Lobu-launched
   * Chromium would be detected or wouldn't have the session.
   */
  bridgeUrl?: string;
  /** CDP endpoint URL, 'auto' to auto-discover, or null to skip CDP entirely. */
  cdpUrl?: string | 'auto' | null;
  /** Stored cookies for Playwright fallback. May be empty. */
  cookies: Cookie[];
  /** Cookie domains to capture after sync (e.g., ['x.com', '.x.com']). */
  authDomains: string[];
  /** Use stealth/anti-detection mode for Playwright launch (default: false). */
  stealth?: boolean;
  /**
   * Persistent --user-data-dir for device-bound browser profiles. When set,
   * Playwright launches via launchPersistentContext so cookies/localStorage
   * are read from (and written to) this directory. CDP is skipped — the
   * profile dir is the source of truth.
   */
  userDataDir?: string;
}

export interface AcquiredBrowser {
  /** Playwright Browser (null when using raw CDP). */
  browser: Browser | null;
  /** Playwright BrowserContext (null when using raw CDP). */
  context: BrowserContext | null;
  /** Playwright Page (null when using raw CDP — use cdpPage instead). */
  page: Page | null;
  /** Raw CDP page handle (null when using Playwright). */
  cdpPage: CdpPage | null;
  /** Resolved CDP WebSocket URL (available when backend is 'cdp'). */
  cdpWsUrl: string | null;
  /** Which backend was used. */
  backend: 'cdp' | 'playwright';
  /** If false, don't close the browser on cleanup (CDP — it's the user's Chrome). */
  ownsBrowser: boolean;
  screenshotDir: string;
}

/**
 * Thrown when all cascade layers fail. Includes diagnostic info about each
 * attempted layer so the user gets an actionable error message.
 */
export class BrowserAuthCascadeError extends Error {
  readonly attempts: Array<{ layer: string; error: string }>;

  constructor(attempts: Array<{ layer: string; error: string }>) {
    const lines = attempts.map((a, i) => `  ${i + 1}. ${a.layer}: ${a.error}`);
    super(
      'Browser authentication failed. Tried:\n' +
        lines.join('\n') +
        '\n\nFix: Enable remote debugging in Chrome (chrome://inspect/#remote-debugging)\n' +
        'Or run: lobu memory browser-auth --connector <key> --auth-profile-slug <slug>'
    );
    this.name = 'BrowserAuthCascadeError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/**
 * Acquire a browser session using a two-layer cascade:
 * CDP first (if available), then Playwright with stored cookies.
 */
export async function acquireBrowser(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const attempts: Array<{ layer: string; error: string }> = [];

  // --- Bridge: drive user's real signed-in Chrome via @lobu/browser-bridge ---
  // Highest priority — when the caller picked this mode, falling back to a
  // headless Playwright launch would silently lose the user's session and
  // (for sites like Revolut) get the connector blocked. Fail loud instead.
  if (opts.bridgeUrl) {
    try {
      return await acquireViaBridge(opts);
    } catch (err: any) {
      attempts.push({ layer: 'Bridge', error: err.message });
      throw new BrowserAuthCascadeError(attempts);
    }
  }

  // --- Persistent profile path: cookies live in --user-data-dir ---
  // Skip CDP entirely — the profile dir is authoritative for cookies/state.
  if (opts.userDataDir) {
    try {
      return await acquireViaPersistent(opts);
    } catch (err: any) {
      attempts.push({ layer: 'Playwright persistent', error: err.message });
      throw new BrowserAuthCascadeError(attempts);
    }
  }

  // --- Layer 1: CDP ---
  if (opts.cdpUrl !== null && opts.cdpUrl !== undefined) {
    try {
      return await acquireViaCdp(opts);
    } catch (err: any) {
      attempts.push({ layer: 'CDP', error: err.message });
      sdkLogger.info(
        { error: err.message },
        '[BrowserAcquire] CDP not available, trying Playwright'
      );
    }
  }

  // --- Layer 2: Playwright (with stored cookies if available) ---
  try {
    return await acquireViaPlaywright(opts);
  } catch (err: any) {
    attempts.push({ layer: 'Playwright', error: err.message });
  }

  // --- All layers failed ---
  throw new BrowserAuthCascadeError(attempts);
}

// ---------------------------------------------------------------------------
// Layer implementations
// ---------------------------------------------------------------------------

async function acquireViaBridge(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  // Dynamic playwright import to match the pattern in acquireViaPersistent —
  // playwright is an optional peer dep; connector-sdk consumers without it
  // shouldn't pay the import cost just because the type signature exists.
  const playwrightModule = 'playwright';
  const { chromium } = await import(/* @vite-ignore */ playwrightModule);

  const url = opts.bridgeUrl!;
  const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR ?? '/tmp/feed-screenshots';

  // bridgeUrl is the full ws://host:port/cdp?token=... — auth lives in the
  // query string, NOT in headers. Don't pass an Authorization Bearer here.
  const browser = (await chromium.connectOverCDP(url)) as Browser;
  try {
    // The bridge fronts the user's existing Chrome — there should already
    // be a default context with the user's open tabs/cookies/storage. Use
    // it rather than newContext, which on connectOverCDP returns an
    // isolated incognito context and defeats the whole point.
    //
    // Fail loud if there's no context — silently creating a fresh incognito
    // would (a) lose the user's session, and (b) the connector would happily
    // run against the wrong browser state and get blocked. Worse than
    // throwing.
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error(
        '@lobu/browser-bridge: connected to relay but no browser context was advertised. ' +
          'The extension probably is not attached to any tab. Open Chrome and click ' +
          "the Lobu extension's toolbar icon on a tab, then retry."
      );
    }
    const context = contexts[0] as BrowserContext;
    if (opts.cookies.length > 0) {
      await context.addCookies(opts.cookies);
    }
    // pages()[0] picks an arbitrary attached tab. Acceptable for the spike
    // since the extension attaches one tab at a time today; multi-tab
    // selection (active tab, named tab, new tab) is a follow-up.
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    sdkLogger.info({ url }, '[BrowserAcquire] Connected via @lobu/browser-bridge');

    return {
      browser,
      context,
      page,
      cdpPage: null,
      cdpWsUrl: url,
      backend: 'playwright',
      // user's Chrome — caller must NOT call browser.close() (would close
      // their browser). Cleanup of the CDP attachment is handled by the
      // extension on disconnect; the relay closes the WS when bridge.close()
      // is invoked on the BridgeServer handle (separate concern from
      // ownsBrowser).
      ownsBrowser: false,
      screenshotDir,
    };
  } catch (err) {
    // Bridge connect succeeded but downstream setup failed. Drop the WS
    // connection so we don't leak a CDP attachment on the user's Chrome.
    // browser.close() on a connectOverCDP Browser disconnects the CDP
    // session — it does NOT close the user's Chrome itself.
    await browser.close().catch(() => {});
    throw err;
  }
}

async function acquireViaCdp(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const wsUrl = await resolveCdpUrl(opts.cdpUrl === 'auto' ? 'auto' : opts.cdpUrl, {
    loggerLabel: 'BrowserAcquire',
    preferRealBrowser: true,
  });

  const cdpPage = await CdpPage.create(wsUrl);

  sdkLogger.info({ wsUrl }, '[BrowserAcquire] Connected via raw CDP');

  return {
    browser: null,
    context: null,
    page: null,
    cdpPage,
    cdpWsUrl: wsUrl,
    backend: 'cdp',
    ownsBrowser: false,
    screenshotDir: '/tmp/feed-screenshots',
  };
}

async function acquireViaPersistent(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const playwrightModule = 'playwright';
  const { chromium } = await import(/* @vite-ignore */ playwrightModule);
  const isDebug = process.env.BROWSER_DEBUG === '1';
  const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR ?? '/tmp/feed-screenshots';
  const context = (await chromium.launchPersistentContext(opts.userDataDir!, {
    headless: !isDebug,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })) as BrowserContext;
  try {
    if (opts.cookies.length > 0) {
      await context.addCookies(opts.cookies);
    }
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    sdkLogger.info(
      { userDataDir: opts.userDataDir, cookies: opts.cookies.length },
      '[BrowserAcquire] Launched Playwright with persistent --user-data-dir'
    );
    return {
      browser: context.browser() ?? null,
      context,
      page,
      cdpPage: null,
      cdpWsUrl: null,
      backend: 'playwright',
      ownsBrowser: true,
      screenshotDir,
    };
  } catch (err) {
    // addCookies / newPage failed — close the persistent context so we
    // don't leak a long-lived Chromium process holding the profile lock.
    await context.close().catch(() => {});
    throw err;
  }
}

async function acquireViaPlaywright(opts: AcquireBrowserOptions): Promise<AcquiredBrowser> {
  const { browser, screenshotDir } = await launchBrowser({
    stealth: opts.stealth ?? false,
  });

  try {
    const context = (await (browser as Browser).newContext()) as BrowserContext;
    if (opts.cookies.length > 0) {
      await context.addCookies(opts.cookies);
    }

    sdkLogger.info(
      { cookies: opts.cookies.length },
      '[BrowserAcquire] Launched Playwright with stored cookies'
    );

    const page = await context.newPage();

    return {
      browser: browser as Browser,
      context,
      page,
      cdpPage: null,
      cdpWsUrl: null,
      backend: 'playwright',
      ownsBrowser: true,
      screenshotDir,
    };
  } catch (err) {
    // newContext/addCookies/newPage threw — don't leak the launched browser.
    await (browser as Browser).close().catch(() => {});
    throw err;
  }
}
