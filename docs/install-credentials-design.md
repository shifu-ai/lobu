# Install Operator Credentials — design (A1 redesign)

Status: **draft**. Supersedes the original "install identity at boot" spike
(`docs/install-identity-design.md` — not landed). The A1 brief was rewritten
after design review surfaced two structural problems with the original
direction.

This doc is design-only. **No implementation.** Reviewed and approved here,
implementation follows as a separate PR.

---

## Why the original A1 was abandoned

Original A1 ("install identity at boot"): provision a `principal_kind='install'`
user row at server boot, mint install-scoped PATs for loopback callers via
`POST /api/local-init`.

Two problems:

1. **The trust boundary was network-topology, not cryptographic.** Codex
   flagged this from the start. A loopback endpoint that hands out an
   admin-grade PAT to any local caller means "any same-host process can
   become Lobu." Same-host unprivileged users (multi-tenant Linux box,
   container with multiple UIDs, shared dev VM) can call `/api/local-init`
   and walk away with admin. Container port-maps and forward-stripping
   reverse proxies amplify the attack surface. The mitigations we
   considered — Unix-domain sockets, bootstrap-token files at `0600` —
   are real defences, but they're patching a structural issue: the
   endpoint had no secret to verify.
2. **The "install" principal is a new audit class.** Stage 2 of the
   original plan needed: `principal_kind` column, audit-label rendering
   in the events browser, a claim-flow to fork install-owned events into
   the first human's workspace, and special-casing the single-user-mode
   counter. All of that is real work paid for by a principal class that
   exists *only* because the CLI couldn't bootstrap a credential.

The redesign replaces the install identity with **a real user with at
least one credential, established at first install action.** Trust
becomes cryptographic (you need the password / passkey to sign in),
audit becomes attribution-by-operator-name (no "Lobu install" pseudo-
user), and the single-user-mode counter is unchanged.

---

## Refined model: password-at-init with flexible first credential

The install operator is **a normal `better-auth` user**. The user has
one or more credentials attached (password, passkey, magic-link, OAuth).
Better Auth supports all of these natively. **The TYPE of the first
credential depends on which install channel registers the user.**

### Install channels and their first credential

| Channel | First credential | Subsequent credentials |
|---|---|---|
| `lobu init` (CLI scaffold, no webview) | Password (prompted at init) | Passkey via web settings; OAuth via web settings |
| Menubar / web `/sign-up` (first-open) | Passkey (WebAuthn enrolment) | Password via web settings ("Enable CLI access"); OAuth |
| Headless CI / Docker | Password (env or stdin) via `lobu init --yes --mode <mode> --password "$LOBU_PASSWORD"` | — |
| Multi-tenant cloud (operator brings own users) | Admin bootstrap token (separate design, see §6) | Each tenant user signs up normally via web |

The model is **additive** — credentials layer on. A CLI-first user who
later installs the menubar uses their existing password to sign in
through the menubar's password form, then is offered passkey enrolment
as a convenience. A menubar-first user who later wants CLI goes to web
settings → "Enable CLI access" → sets a password retroactively. No
forking, no second account.

### What this replaces

- **No install-identity principal class.** Every actor is a real human
  user (or, in multi-tenant cloud mode, a real human in their tenant org).
- **No install-scoped PAT minting from `/api/local-init` to unauthenticated
  callers.** The endpoint still exists for the menubar — but it now
  requires a valid Better Auth session cookie (the menubar already holds
  one after passkey sign-in). The "zero users yet, mint anyway" branch
  is gone.
- **No boot-time provisioning of synthetic users.** First-boot DB is
  empty until the operator runs `lobu init` or visits `/sign-up`.

---

## CLI flow — `lobu init`

`lobu init` is the entrypoint for non-menubar installs. It does
three things in order:

1. **Scaffold project files** (`lobu.toml`, `agents/`, `.env`). This part
   already works in the existing scaffold flow.
2. **Set the install mode.** Writes `LOBU_SINGLE_USER=1` or `=0` to the
   project `.env`. Default is `1` (single-user). Override with
   `--mode multi-user`.
3. **Mint the first operator's credential.**
   - Interactive mode: prompt for email, prompt for password (with
     confirm + strength check). Hash via better-auth's credential
     hasher and insert the user + account row directly into the DB.
     This is the only place we write a credential outside of better-auth's
     HTTP flow; it's a one-shot bootstrap, not a long-lived path.
   - `--yes` mode (CI): require `--password "$LOBU_PASSWORD"` and
     `--email "$LOBU_EMAIL"`. No prompts; fail if either is missing.
   - `--mode multi-user`: skip step 3 entirely. No initial user is
     created. The first menubar/web visitor signs up normally.

After `lobu init` finishes, the operator can run `lobu run` to boot the
server. The first `lobu login --password "$PASSWORD"` call POSTs to
`/api/auth/sign-in/email` (Better Auth's built-in handler), receives a
session, and exchanges it for a PAT through `/api/local-init`.

### Why direct-insert is OK for `lobu init`

Better Auth's HTTP signup path requires the server to be running. `lobu
init` runs **before** the server boots, against a fresh DB. The
alternative would be `lobu init` → start server → HTTP signup → stop
server, which is fragile and produces a worse error story when the
signup fails. Direct insert is one place using the same hashing
function Better Auth uses internally; we re-export it from the auth
module for this purpose.

---

## Menubar / web flow — `/sign-up` with passkey-first

The menubar bundles the SPA. On first open against an empty install:

1. SPA detects `hasUser=false` (via the existing `/api/auth/config`
   endpoint) and shows the `/sign-up` page.
2. The sign-up form offers **passkey enrolment** as the primary path —
   "Use Touch ID / Face ID / security key." Email + display name only;
   no password field.
3. Better Auth's passkey plugin (`@better-auth/passkey`, already wired
   in `auth/index.tsx:536`) completes the WebAuthn ceremony, creates
   the user, attaches the passkey credential.
4. Personal org is provisioned by the existing `databaseHooks.user.create.after`
   hook. Default agent is provisioned. No claim flow.

Password fallback is offered for users whose browser doesn't support
WebAuthn, or who want a password for CLI access from the start. The
existing email+password flow handles this — no new code.

---

## Web settings — "Enable CLI access"

A menubar-first user who later wants CLI sees a new section in their
account settings:

> **CLI access**
> The Lobu CLI signs in with a password. You currently have no password
> set. Click below to choose one.
>
> [Set password]

Inline form (per DESIGN_GUIDELINES §1 — embedded, not modal). On submit,
hits `/api/auth/set-password` (better-auth's built-in). After save, the
operator can run `lobu login --password "$X"` from the CLI.

The same section also lists active PATs (already exists) — adding
"Reset CLI password" as an inline action when a password exists is a
small additive change.

---

## `LOBU_SINGLE_USER` — where it lives

Today: `LOBU_SINGLE_USER=1` is set by `start-local.ts` line 113-115 if
unset, persisted to the project `.env` only when the operator manually
writes it. The auth hook reads it from `c.env` (`auth/index.tsx:567`).

Under the redesign: **stays in `.env`, owned by `lobu init`.** Reasons:
- `.env` is the source of truth the operator already edits. Putting
  install-mode in the DB and `.env` creates two places to disagree.
- `lobu init` already writes `.env`; one more line is trivial.
- Multi-tenant cloud installs override via env at deploy time
  (Kubernetes `Env`, Docker `-e`), which works today.

The auth hook's check is unchanged. The redesign doesn't move
`LOBU_SINGLE_USER` into the DB.

---

## What happens to PR #902 ("first signup = install identity")

PR #902 removed the pre-seeded `bootstrap-user` row and added a hook
that lets the first `/sign-up` claim the install's single-user slot.
**Survives in spirit.** The new model:

- `bootstrap-user` stays gone (PR #902 was right to remove it).
- "First signup = the install's operator" is the same outcome — there's
  just no name for it (`principal_kind='install'`). The first user IS
  the install operator; subsequent signups are blocked by the
  single-user-mode hook.
- The `/api/local-init` "no_user_yet" branch is **revised**, not
  removed: when `LOBU_SINGLE_USER=1` and zero users exist, return a
  pointer at `lobu init` for CLI callers (`X-Lobu-Client: cli`) and
  `/sign-up` for browser callers. The CLI is then expected to prompt
  the operator to run `lobu init`, which it can do from the same
  process.

The Stage-2 work in PR #902 that wired the SPA's `/sign-up` route +
config-endpoint copy + `signup_url` redirect target is untouched.

---

## `/api/local-init` after the redesign

The endpoint stays, with two changes:

1. **No more anonymous loopback mint.** Today, a loopback caller with
   `X-Lobu-Client: anything` gets a session + PAT for "whichever user
   exists." After the redesign, this branch requires a valid existing
   session cookie (or a `?token=` exchange) — i.e. the caller must
   already be authenticated through Better Auth. The endpoint becomes
   a **session-to-PAT exchange** for clients that hold a session token
   from password / passkey sign-in but need a long-lived PAT for
   bearer auth.

2. **Loopback peer check + X-Lobu-Client header stay**, downgraded
   from "primary trust boundary" to "CSRF defence-in-depth." Cryptographic
   trust (the session/password) is the primary; the network checks
   block CSRF and accidental LAN exposure.

The CLI flow becomes:

```
lobu login --password "$X"
  → POST /api/auth/sign-in/email { email, password }
    → Set-Cookie: better-auth.session_token=<...>
  → POST /api/local-init  (with the cookie)
    → 200 { session_token, device_token (PAT) }
  → CLI persists device_token to ~/.config/lobu/credentials.json
```

`lobu login --token "$PAT"` continues to work for users who minted a
PAT from web settings — no password needed.

---

## Token lifecycle and audit

**Token storage**: unchanged. Same `personal_access_tokens` table.
PATs are owned by real human users.

**Revocation**: unchanged. Same admin UI, same `revoke()` path. There's
no install-identity PAT to special-case.

**Audit labels**: events created by automation (watcher runs, scheduled
tasks, agent execution) attribute to whichever **human operator** owns
the agent. Today's `metadata.author_name` field already carries the
user's display name; the events browser already renders this. No new
column, no `[system]` badge to design.

The one wrinkle: in multi-tenant cloud mode (§6), automation runs
under an admin-bootstrap token that doesn't belong to any specific
tenant operator. That path needs an explicit "system" attribution —
addressed in §6 below.

---

## Multi-tenant mode — admin bootstrap token

`lobu init --mode multi-user` skips the credential prompt. The result
is a server that boots empty; the first menubar/web visitor signs up
and becomes the first human, no single-user cap.

But automation deployment is still needed: a Kubernetes Job that runs
`lobu apply` against the multi-tenant install at deploy time has no
user to sign in as. The fix: **a one-time admin bootstrap token,
generated by `lobu init --mode multi-user`** and stored at
`$LOBU_DATA_DIR/.admin-bootstrap-token` (perms `0600`).

The token is a single-use admin grant: the first time it's used, it
mints an "admin" user (`is_admin=true` column on `user`), the token
self-destructs (deleted from the file + a corresponding `revoked_at`
in the DB), and from then on the admin signs in via password like
anyone else. The admin user owns automation events; the audit label
is just their display name (`"Admin"` or whatever they pick).

Design of this admin-token mechanism is **out of scope for this PR**
— it's a separate concern that the multi-tenant cloud story owns. This
doc notes it to confirm the redesign handles the case without forcing
the install-identity principal class back in.

---

## Open questions

### Q1 — Menubar-first headless variant

**Scenario**: a user installs Lobu via the menubar, never touches the
CLI, then later wants to script something. Today they'd go to web
settings and create a PAT. Under the redesign, that path still works
— but it's a few clicks vs `lobu init`'s one-shot.

**Option A**: add a `lobu cli-token` command (or similar) that, given
an existing session token (deep-linked from the menubar's "Use in
CLI" button), mints a PAT and persists it. The menubar opens
`lobu://cli-init?token=<session>` which the CLI handles.
**Option B**: leave it as "go to web settings, generate a PAT, paste
it into `lobu login --token`."

**Recommendation**: **B for v1.** The menubar-first user who wants CLI
is rare; the existing flow works. Add **A** later if friction is real.

### Q2 — Password recovery

**Scenario**: operator loses their password. In single-user mode,
losing the password locks them out of their install permanently —
unless they have a passkey or magic-link as a second credential.

**Options**:
1. **`lobu reset-password` CLI** — same-host loopback flow that
   verifies via the data-dir's filesystem perms (same UID = same
   trust) and updates the password directly. This is the
   network-topology trust model we just abandoned; reject for the
   same reasons.
2. **Recovery key at init** — `lobu init` generates a 256-bit recovery
   token, writes to `$LOBU_DATA_DIR/.recovery-key` (`0600`), prints
   it once to stdout. Operator can `lobu reset-password --recovery-key
   "$X"` later. The key file IS a same-host-trust mechanism, but it's
   a long-lived secret an attacker would have to read directly off
   disk; **cryptographic** (need the key) **and** behind FS perms.
3. **Recovery via email** — magic link sent to the operator's email,
   reuse Better Auth's existing password-reset flow. Requires
   `RESEND_API_KEY` set; local dev installs without it can't recover.
4. **No recovery** — lose the password, restore from backup or
   reinstall. Brutal but defensible for `/tmp` scaffolds.

**Recommendation**: **(2) + (3) layered.** Recovery-key file at init
for installs without email; magic-link fallback for installs with
`RESEND_API_KEY` set. Both backends, operator picks at reset time.

### Q3 — Vault-grade KDF (v2)

The user mentioned "like you're building Vault." A natural extension:
the operator's password also derives `ENCRYPTION_KEY` (used to encrypt
secrets at rest in `secret-proxy` and the secrets table). Then losing
the password = losing access to secrets, but also = nobody can read
secrets without authenticating.

**This is a big change**: every secret in the DB is currently
encrypted with `ENCRYPTION_KEY` from `.env` or an ephemeral key.
Re-keying on password change requires re-encrypting every secret.
And operators with passkey-only credentials (no password) need
a separate key-derivation source.

**Defer to v2.** Flagged here so we don't lock out the option in
v1's schema. The minimal hook: store `kdf_params` on the user row
(salt, iteration count, derivation purpose) so a future migration
can derive a wrapping key without re-architecting.

### Q4 — CSRF on `/api/local-init`

The existing `X-Lobu-Client` header and loopback peer check are
**CSRF mitigations**, not the trust boundary. They stay.

A web page on `evil.com` can't add custom headers to a `fetch()`
against `http://localhost:8787` without a CORS preflight, which
this endpoint doesn't permit. The header gate keeps that intact even
though the redesign's primary trust is the session cookie itself
(which an `evil.com` page also can't forge or read).

### Q5 — Existing-install migration

Installs that already have a web-signup user (because they ran the
old `bootstrap-user`-removal flow or used `/sign-up` first) are
**already in the new model.** They have a real `user` row with a
real password (or OAuth account or passkey). No migration needed.

Installs that were minted via the original `/api/local-init`
"no_user_yet → mint for whoever's first" branch may have a user
with no credentials at all (the row exists, no password was ever
typed). Detect this at SPA load by hitting `/api/auth/config` and
checking `hasUser && !hasCredentials` — if so, the SPA routes them
to a "Set your password" wall before any other UI. One-time prompt
per install.

---

## Decision summary (for the review at the top of the PR)

1. **No install-identity principal class.** Every actor is a real
   user; trust is cryptographic.
2. **`lobu init` mints the first password-credentialled user at
   project scaffold time.** Interactive prompt, or `--yes --password`
   for CI. Multi-user mode skips this.
3. **Menubar / web `/sign-up` defaults to passkey enrolment.** No
   password forced.
4. **CLI access for menubar-first users**: enable via web settings
   → "Set password." Inline form, no modal.
5. **`/api/local-init` becomes a session-to-PAT exchange.** No
   anonymous mint. CSRF/loopback checks stay as defence-in-depth.
6. **`LOBU_SINGLE_USER` stays in `.env`**, owned by `lobu init`.
7. **PR #902's "first signup = install operator" survives in spirit**
   — same outcome, no principal-class rename.
8. **Multi-tenant cloud mode** gets a separate one-time admin
   bootstrap token (out of scope for this PR's implementation).
9. **Password recovery** = recovery-key file at init + magic-link
   fallback (open for review).
10. **Vault-grade KDF** deferred to v2; minimal `kdf_params`
    column shape allowed for in v1 schema.

---

## Out of scope for the implementation PR (Stage 2)

- Multi-tenant admin bootstrap token (separate design, separate PR).
- Vault-grade KDF / secret re-keying (v2).
- Audit `[system]` labels (no install-identity = no system pseudo-user
  = no labels to design).
- Claim flow (no install-identity = nothing to claim).
- `principal_kind` column / discriminator (no install-identity).

## In scope for Stage 2 implementation (NOT this PR)

1. `lobu init` CLI: password prompt, `--yes --password --mode`, write
   `.env`, direct-insert user + account rows.
2. SPA `/sign-up`: passkey-first form (default), password fallback.
3. SPA settings: "Enable CLI access" / "Set password" inline section.
4. `/api/local-init`: require session, return PAT; remove "no user
   yet → mint" branch; replace with "ask the caller to run `lobu init`."
5. `/api/auth/config`: surface `hasCredentials` so the SPA can route
   credential-less users to "set password" before showing UI.
6. Recovery: write `.recovery-key` at `lobu init`; `lobu reset-password
   --recovery-key`; magic-link fallback path.
7. Tests: e2e cover (a) `lobu init` → `lobu login --password` works;
   (b) menubar passkey signup → CLI password-set flow works; (c)
   `/api/local-init` rejects unauthenticated callers.

The 5-PR landing order the user mentioned applies — this design doc
PR is #1 of 5. Coordinate with `scaffold-dx` for the `.env` template
wording around `LOBU_SINGLE_USER` and password expectations.
