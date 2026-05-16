# No-auth mode for the embedded Lobu server

## Status

**Phase A shipped** in the Mac menu bar app. Phase B (server-side hardening) deferred — not strictly required for the personal-use threat model, can be revisited if/when we expose the embedded server beyond loopback.

---

## Goal

When the macOS menu bar app starts the embedded Lobu server on `127.0.0.1`, the user shouldn't have to sign in. There's one human on this Mac, the data is on this Mac, the server is on this Mac. The email + password ceremony is theater.

---

## Phase A: Mac app adopts the bootstrap PAT (shipped)

The audit revealed that `lobu run` already does most of the work on its own. On first boot of an empty embedded server, `ensureBootstrapPat()` (`packages/server/src/start-local.ts`) creates:

- A default user (`bootstrap-user`, `Local Developer`, `dev@lobu.local`).
- A personal org (`dev` slug).
- An owner membership wiring those two together.
- A long-lived PAT, written to `<LOBU_DATA_DIR>/bootstrap-pat.txt` with mode `0600`.
- A Better Auth credential for the web SPA so "Open Lobu" works too.

Phase A in the Mac app simply **reads that file after `startLocalLobu()` returns** and synthesises an `OAuthCredentials` from it. No OAuth device flow, no browser, no code shown.

### Implementation (apps/mac/Lobu)

- `LocalLobuRunner.bootstrapPATPath` — static URL pointing at `~/lobu/data/bootstrap-pat.txt`.
- `AppState.connect()` — when `matchesManagedRunner(url)` is true, calls `adoptBootstrapCredentialsIfAvailable(baseURL:)` after the runner is up. Falls through to OAuth if the file isn't there (defensive: we're never strictly worse than today's behavior).
- `AppState.waitForBootstrapPAT(timeout:)` — polls every 250 ms for up to 10 s, because the HTTP listener comes up before `ensureBootstrapPat()` finishes; "reachable" doesn't mean "file exists yet."
- `MenuBarContent.connectButtonTitle` — flips to "Start" / "Connect" (instead of "Start & sign in") when the URL targets the managed runner.

**User experience:** click "Start" once. The Mac app spawns `lobu run`, waits for the PAT file, then the popover transitions to signed-in. No browser, no code, no approval click.

### Security boundary today

- Server only listens on `127.0.0.1` (the runner spawns it that way).
- The PAT lives at mode `0600` — only the user who owns the file can read it.
- Same-user processes on the Mac can read the PAT, the Keychain, the home directory, etc. — same trust boundary as everything else running as your user.
- A malicious website on this Mac **could** call `127.0.0.1:8787/api/...` from a browser tab. It can't read the PAT, so the calls would be unauthenticated — and existing routes require auth. **CSRF is not currently strict** on this server, so a confused-deputy attack via the Better Auth session cookie (if the user logged into the web SPA) is theoretically possible. Phase B closes this.

---

## Phase B: Server hardening (deferred)

Not required for personal use today but worth doing if we ever:

- Make exposing the server easier (Tailscale defaults, Funnel docs).
- Add features that change blast radius (writing to local files outside `~/lobu`).
- Get a security report or close-call.

What it would cover:

- **CSRF middleware** on mutating routes: `Origin` + `Sec-Fetch-Site` + `Host` + `Content-Type` checks. Required because any browser tab on the Mac can `fetch('http://127.0.0.1:8787/...')`.
- **Loopback bind enforcement**: server refuses to start when `LOBU_NO_AUTH=1` (or its equivalent) and bind is non-loopback. Post-listen assertion via `server.address()`, not just a config check.
- **`LOBU_NO_AUTH=1` env**: the existing auth middleware short-circuits when set. The bootstrap PAT becomes optional rather than primary — Mac app can send no `Authorization` header at all and still be attributed to the default user.
- **Tunnel advisory**: best-effort startup warning if `tailscaled` + Funnel, `ngrok`, or `cloudflared` is detected.
- **Per-user data dir + port** for shared Macs (out-of-band of the auth work but blocks shared-machine support).

None of these are *load-bearing* for the personal-use story today — the Mac app talks to the server with a PAT, the server enforces auth, the file is `0600`. They're additional layers if/when the threat model shifts.

---

## Open questions (deliberately small)

- **`Open Lobu` from the footer** still opens `http://localhost:8787/` blindly. The web SPA's existing Better Auth credential bootstrap means the user is *able* to sign in (same `dev@lobu.local` + a generated password — see `ensureBootstrapPat`'s `webPassword` field), but they have to actually do it. A follow-up could either auto-fill that, or share a session token via URL once Phase B's CSRF is in place.
- **Shared Macs.** Per-user data dir + per-user port. Track for follow-up.
- **Reset path.** If the PAT file gets corrupted or deleted, the next `lobu run` boot recreates it (the `if (existsSync(patFilePath)) return` early-out skips, but only because the user-count guard above it also skips). Worth verifying once we add a "Reset Lobu" footer action.
