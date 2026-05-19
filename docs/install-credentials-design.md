# Install Operator Credentials — design (A1 v3)

Status: **draft**. Third revision of the A1 design. Supersedes the
"password-at-init" model (v2, commits `5fbef11a` + `f9c883d5` on this
branch) and the earlier "install identity at boot" spike
(`docs/install-identity-design.md`, never landed).

This doc is design-only. **No implementation.** Reviewed and approved
here, implementation follows as a separate PR.

---

## TL;DR

**`ENCRYPTION_KEY` is the install operator's auth credential.** The
random 32-byte hex value that `lobu init` already writes to `.env`
(packages/cli/src/commands/init.ts:413) doubles as the install
operator's password in better-auth. Same secret unlocks at-rest
encryption AND signs into the web/CLI. No separate password prompt,
no separate vault key, no separate v2 migration.

This collapses what previous revisions split into "v1 auth" and
"v2 encryption-at-rest." They were always the same thing.

---

## Why this is better than v2 (password-at-init)

| Concern | v2 (password-at-init) | v3 (ENCRYPTION_KEY-as-password) |
|---|---|---|
| Scaffold UX | Interactive password prompt at `lobu init` | None — `lobu init` is silent like today |
| Number of irreplaceable secrets | 2 (password + ENCRYPTION_KEY) | 1 (ENCRYPTION_KEY) |
| Recovery story | Recovery-key file + magic link, new design | Same as today — `ENCRYPTION_KEY` was already irreplaceable |
| v2 vault migration | Wrap ENCRYPTION_KEY with password-derived key | Not needed — auth-credential IS the vault key from day one |
| Key rotation semantics | Two independent rotations | Rotate once → revokes auth AND invalidates at-rest reads ("rotate = nuke") |
| First-device web/menubar UX | Sign-up with email + passkey enrolment | "Paste install secret" once → enrol passkey, never see it again (1Password Secret Key pattern) |

The 1Password / Bitwarden analogy isn't decoration — it's the
operative model. `ENCRYPTION_KEY` plays the role of 1Password's
**Secret Key**: an unmemorable, machine-generated, never-rotated-
unless-you-mean-it credential that you paste **once per new device**
and is replaced by a passkey thereafter.

---

## The boot flow

```
$ lobu init my-install
  → writes .env with ENCRYPTION_KEY=<32 random bytes hex>    (today, unchanged)
  → writes lobu.toml, agents/, etc.                          (today, unchanged)
  No prompts. No interactive steps.

$ lobu run
  → loads .env (today)
  → migrates DB (today)
  → ensureInstallOperator()  ← NEW, idempotent
      if no user has principal_kind='install_operator':
        - INSERT user (id='operator_<rand>', email='operator@<hostname>.local',
                        name='Install operator', principal_kind='install_operator')
        - INSERT account (providerId='credential', userId=<above>,
                          password=better_auth_hash(ENCRYPTION_KEY))
        - run databaseHooks.user.create.after → personal org + default agent
      else:
        - no-op
  → start HTTP listener
```

`ensureInstallOperator()` is idempotent. It runs every boot. On the
first boot of a fresh install it provisions the operator; on every
subsequent boot it sees the row and returns immediately. **The hash
in the `account` row is the trust anchor** — anyone who can produce
the same plaintext can sign in.

### Why this isn't network-topology trust

The original "install identity at boot" A1 was network-topology
(loopback-only `/api/local-init` mints a PAT). v3 is cryptographic:
the secret is a 256-bit random value held in `.env`. An attacker
needs to read `.env` itself (which already grants at-rest decrypt
today). No new trust boundary.

Same-host unprivileged user on a multi-tenant Linux box? They need
read access to `.env`. If they have that, they already had at-rest
decrypt today — no regression. If they don't, `/api/auth/sign-in/email`
returns 401 like for any wrong password.

---

## CLI auth — `lobu login`

```
$ lobu login                    # no args, on the install host
  → reads .env, grabs ENCRYPTION_KEY
  → POST /api/auth/sign-in/email { email: 'operator@<hostname>.local',
                                    password: ENCRYPTION_KEY }
  → receives Set-Cookie: better-auth.session_token
  → POST /api/local-init (with cookie)
  → receives { device_token: <owl_pat_*>, ... }
  → persists in ~/.lobu/contexts.json under context 'local'  (today, unchanged)
```

The email is **derived deterministically from the install** (e.g.
`operator@<hostname>.local` or `operator@<install_id>.lobu.local`).
The CLI doesn't need to be told what it is; it computes the same
value the server used at provision time.

`lobu login --token <pat>` (no `.env`, cloud/cross-machine case)
**unchanged** — paste a PAT minted from web settings.

### What happens if `.env` is missing or corrupted

`lobu login` errors out: "ENCRYPTION_KEY not found in .env — is this
a Lobu project directory?" Same error the rest of the CLI produces
today when the project isn't set up. No new failure mode.

---

## Web / menubar — first-open flow

The menubar bundles the SPA. On first open against an install that
has a `principal_kind='install_operator'` row but no human session
on this device:

1. SPA hits `/api/auth/config`, sees `hasInstallOperator=true,
   currentDeviceHasSession=false`.
2. Renders a **"Connect this device" screen**:
   > **Connect your Lobu install**
   >
   > Paste your install secret to set up this device. You'll find it
   > as `ENCRYPTION_KEY` in your project's `.env`.
   >
   > [paste field] [Connect]
3. On submit, POST to `/api/auth/sign-in/email` with the synthetic
   operator email + pasted value. Set-Cookie returns.
4. SPA immediately routes to **passkey enrolment** (better-auth's
   `passkey` plugin, already wired at auth/index.tsx:536):
   > **Set up Touch ID / Face ID for this device**
   >
   > Next time you open Lobu here, you'll sign in with biometrics —
   > you won't need the install secret again.
   >
   > [Enable passkey] [Skip]
5. After passkey enrolment (or skip), normal SPA loads.

**Subsequent opens on the same device**: passkey or passcode (see
below). The install secret is never re-prompted on this device. It's
the bootstrap credential, not a daily-driver.

**Connecting another device**: same flow — paste once, enrol
passkey/passcode, done. The user can have N device passkeys all
bound to the same `install_operator` user row.

### Convenient unlock: passkey or passcode

After the initial sign-in (step 3 above), the menubar offers
**post-sign-in** enrolment for everyday convenience. Both options
unlock a PAT stored in the OS keychain; neither changes the
better-auth credential layer:

| Option | What it does | Storage |
|---|---|---|
| **Passkey** (recommended) | WebAuthn, Touch ID / Face ID | macOS Keychain, Secure Enclave-backed where available |
| **Passcode** (4–6 digit PIN) | Releases a stored PAT from Keychain after PIN check | macOS Keychain with `kSecAttrAccessControlUserPresence` + PIN gate; Keychain enforces rate-limit + lockout |

Both can be enrolled in parallel — either unlocks. The user can
disable one in settings. If neither enrolment finishes, the menubar
falls back to "paste install secret each open" — mildly annoying
but secure.

Daily flow with a passcode enrolled: user opens menubar → passcode
prompt → Keychain releases the stored PAT → menubar authenticates
to the gateway with that PAT. The passcode never travels off-device
and never touches the gateway.

**Security considerations.**

- **The passcode is NOT a KDF input.** A 4–6 digit PIN has ~13–20
  bits of entropy and would be brute-forceable offline in minutes
  if used to derive cryptographic material against disk-stored
  ciphertext. The passcode is **a UI lock over a stored PAT**, not
  an alternative auth credential at the better-auth layer.
- **Rate limiting belongs to the OS.** macOS Keychain has
  hardware-backed throttling and progressive lockout for ACL
  checks; we delegate to it rather than implementing our own
  rate-limited PIN store. Same reason iOS uses the Secure Enclave
  for the device passcode.
- **`ENCRYPTION_KEY` remains the root of trust.** Passkey + passcode
  are device-local conveniences over a PAT that was issued *because*
  the operator proved possession of `ENCRYPTION_KEY` once. Revoke
  the PAT (web settings) and both convenience unlocks stop working
  for that device.
- **Cross-device passcode sync is out of scope.** Each device has
  its own Keychain entry. A passcode set on the laptop doesn't
  unlock the desktop menubar; the desktop sets its own.

**Platform scope.** Passcode path is **macOS-first** because the
menubar lives there and Keychain ACLs make it cheap. Linux Secret
Service and Windows DPAPI have rough equivalents but each needs
its own ACL design — flagged as future work, not a v3 blocker.
**The web SPA does not get a passcode option** — browsers don't
expose Keychain ACL equivalents portably; passkey is the answer
there.

### Why this is the 1Password pattern

1Password's Secret Key:
- Generated once at account creation, never changes.
- Stored in the 1Password app's vault and the user's emergency kit.
- Required once per device, then replaced by biometrics.
- Combined with the master password for at-rest decryption.

v3's `ENCRYPTION_KEY`:
- Generated once at `lobu init`, never changes.
- Stored in `.env` (the operator's vault — backed up with the
  project; or stored in their password manager).
- Required once per device, then replaced by passkey.
- Currently encrypts at-rest secrets; v3 adds "also unlocks auth."

The mental model maps cleanly. The marketing-page sentence ("Lobu
gives you a vault-grade install secret — paste it once per device,
then unlock with Touch ID") writes itself.

---

## Device pairing: OTP URL flow

Humans should never see or paste the raw `ENCRYPTION_KEY`. It is the
cryptographic root (install operator's better-auth password +
at-rest encryption key, both unchanged from v3 core), but the
**user-visible entry point** for every non-CLI client is a one-time
pairing URL. The CLI keeps its direct path because it has filesystem
access to `.env`.

### Flow

```
   lobu init
       │
       ├── writes .env (ENCRYPTION_KEY, today's behaviour)
       │
       └── writes ~/.lobu/install/<install-id>/pairing.url  (mode 0600)
              │       contains a single-use OTP URL, ~10 min expiry
              │
              ▼
   server boot → ensureInstallOperator() → INSERT into pairing_otps
              {token, install_op_id, expires_at, used_at=NULL}
              ▼
   GET /auth/pair?token=<otp>
       1. validate (exists, not expired, used_at IS NULL)
       2. mark used_at = NOW()
       3. sign caller in as install operator (Set-Cookie)
       4. 302 → /auth/enrol-credential   (passkey | passcode)
              ▼
   user enrols on this device → SPA loads normally
   subsequent opens: passkey / passcode (per addendum #1)
```

### What `lobu init` emits

Unchanged: `.env` with `ENCRYPTION_KEY`. **Added**:
`~/.lobu/install/<install-id>/pairing.url` (mode `0600`) containing
one URL of the form `http://localhost:PORT/auth/pair?token=<otp>`.
Single-use, ~10 min expiry. The file is the bridge between CLI-time
provisioning and GUI-time first connection.

### Server-side

New `pairing_otps` table — five columns: `token` (PK, random 32
bytes), `install_op_id` (FK → `user.id`), `expires_at`, `used_at`,
`created_at`. New route `GET /auth/pair?token=<otp>`:

1. Validate (`exists`, `expires_at > NOW()`, `used_at IS NULL`).
2. Atomically mark `used_at = NOW()` (write-once, race-safe).
3. Mint a better-auth session for `install_op_id` (same path
   `/api/local-init` uses internally).
4. 302 to `/auth/enrol-credential` so passkey/passcode enrolment
   happens immediately after sign-in.

### Per-client first-pairing

- **Menubar (macOS)**: bundles the CLI. After install: internally
  runs `lobu init`, reads `pairing.url` from disk, opens it in the
  webview → SPA auths via OTP → user enrols passkey or passcode →
  done. User never sees the OTP itself.
- **Chrome extension**: same-machine case uses native-messaging to
  read the pairing file → opens the URL in a popup → enrols a
  passkey. Cross-machine case: SPA's "Pair another device" minted
  a separate OTP, user opens that URL in the extension's browser.
- **Second device (phone, other laptop)**: SPA settings → "Pair
  another device" → mints a fresh OTP (different token, same
  shape) → renders as QR or copyable URL → user opens on the
  other device → enrols a credential on that device.

### CLI is unaffected

`lobu login` keeps reading `ENCRYPTION_KEY` directly from `.env`
and POSTs to `/api/auth/sign-in/email`. The CLI runs on the install
host with `.env` in reach; an OTP would be ceremony with no benefit.

### Subsequent pairings

SPA's "Pair another device" is the user-facing minter. Each
invocation produces a fresh OTP row in `pairing_otps`; the init-time
OTP is not reused.

### Revocation

Pairing OTPs are revocable: set `used_at` early to invalidate any
in-flight token (the operator's "I lost the email I sent that URL
to" recovery). Per-device PATs minted post-pairing are independently
revocable via the existing `personal_access_tokens` table — revoking
a device's PAT logs that device out without affecting other paired
devices.

### Security considerations

- **No referer leak.** The redirect target (`/auth/enrol-credential`)
  must not include the OTP. Strip it from the URL before
  `Set-Cookie`. Apply `Referrer-Policy: no-referrer` on the
  `/auth/pair` response (same hardening `/exchange-token` already
  has at `auth/routes.ts:293`).
- **Clear the pairing file after first use.** Once the OTP is
  consumed, `lobu init` / menubar bootstrap deletes the
  `pairing.url` file. A stale URL on disk after the OTP has expired
  is harmless but noisy — clean up to avoid operator confusion.
- **Server-enforced expiry.** Don't trust the URL's query string for
  expiry hints — the `expires_at` check happens against the DB row.
  Clients can render "expired" UI from a `410 Gone` response.
- **One operator per OTP.** Multi-tenant: pairing OTPs are only
  valid for the install operator they were minted for. The
  `pairing_otps.install_op_id` constraint enforces this; the route
  never resolves an OTP to a different user. Tenant operators get
  their own auth surface (`/sign-up` / `/sign-in/email`), not OTP
  pairing.

### What stays the same

- `ENCRYPTION_KEY` IS the install operator's better-auth password
  (v3 core).
- `ENCRYPTION_KEY` encrypts at-rest data (today's behaviour).
- CLI reads `.env` directly; no OTP for CLI.
- Passkey / passcode enrolment after first pairing — unchanged,
  just driven by the OTP redirect instead of a paste prompt.

### What changes

- New `pairing_otps` table + small migration in Stage 2.
- New `GET /auth/pair?token=<otp>` route — the only public-facing
  surface for pairing.
- `lobu init` writes `pairing.url` alongside `.env`.
- SPA gains "Pair another device" in settings (Stage 2 UI).

### Out of scope

- Linux / Windows equivalents of macOS Keychain for passcode UX —
  passkey works on all platforms via WebAuthn; passcode stays
  macOS-first per addendum #1.
- Server-side QR rendering — the server returns a URL; clients can
  render QR locally if useful.
- Multi-tenant pairing OTPs that mint sessions for non-install
  operators — separate flow, not in v1.

---

## `/api/local-init` — what changes, what stays

**Today (post-PR #909):** loopback caller hits the endpoint, the
server looks up "the single user," mints a session + worker PAT.
No password check anywhere in the path.

**Under v3:** the endpoint becomes a **session-to-PAT exchange**:

1. Caller must already hold a valid `better-auth.session_token`
   cookie (obtained from `/api/auth/sign-in/email` with the
   `ENCRYPTION_KEY`).
2. Server reads the session, identifies the user, mints/returns a
   worker-scoped PAT bound to that user + their personal org.
3. Existing loopback peer check + `X-Lobu-Client` header gate stay
   as **defence-in-depth** (CSRF + accidental LAN exposure), not as
   the primary trust boundary.

The "zero users → no_user_yet → /sign-up" branch (auth/routes.ts:431)
**goes away**. Once `ensureInstallOperator()` lands, there is always
a user; the legacy 404 case is unreachable.

---

## Multi-tenant mode

`LOBU_SINGLE_USER` semantics (existing toggle, set by start-local.ts:113-115):

- `=1` (default): only the install operator + their passkey-enrolled
  devices. The `databaseHooks.user.create.before` hook
  (auth/index.tsx:567) blocks additional `/sign-up` calls. Install
  operator is the lone human-facing identity.
- `=0` (multi-tenant cloud): install operator still exists (still
  owns at-rest encryption), but `/sign-up` is open. Each tenant
  signs up normally with their own email + password / passkey /
  OAuth. Their auth flows **don't touch `ENCRYPTION_KEY`** — they
  authenticate against better-auth normally.

The install operator in multi-tenant mode is the **admin / system
actor**: it owns the at-rest key material, it's what `lobu apply`
authenticates as in CI deployments (paste `ENCRYPTION_KEY` as a CI
secret), and it doesn't appear in tenant-facing UI.

### Excluding the install operator from the single-user counter

The `before` hook at auth/index.tsx:567 counts existing users to
enforce single-user mode. Install operator must be excluded from
that count (it isn't "a human user" for the cap). One extra
predicate in the count query:

```sql
SELECT count(*)
  FROM "user"
 WHERE id <> 'bootstrap-user'
   AND principal_kind <> 'install_operator'
```

`principal_kind` is the same discriminator the original install-identity
spike proposed — but instead of being a new audit class, here it's
**purely an internal flag** to exclude the operator from
human-facing counts. It doesn't change audit labels (events
attribute by author name; install operator's name is "Install
operator" and renders normally).

---

## Key rotation

Rotating `ENCRYPTION_KEY` today already invalidates at-rest reads
(secrets in `secret-proxy` and the secrets table can't be decrypted
with the new value). Under v3, rotation **also invalidates auth**:
the install operator's stored password hash matches the old value;
the new value won't sign in.

This is desirable. "Rotate = nuke" is the vault property — losing
trust in `ENCRYPTION_KEY` means losing trust in everything it
gated. Half-rotated states (auth invalidated, secrets still
readable) would be a worse failure mode.

### Mechanical rotation (operator wants to change keys)

Two paths:

1. **Backup-restore**: dump → rotate `ENCRYPTION_KEY` → re-encrypt
   all secrets with the new key → re-hash the install operator's
   account row with the new value → restore. This is the documented
   procedure; it's a deliberate operation, not a one-click feature.
2. **Forget-and-recreate**: nuke `.env`, re-run `lobu init`,
   re-onboard all integrations. For a fresh `/tmp` install with
   nothing to lose, fastest path.

v3 doesn't ship rotation tooling. The doc captures it so future
work knows what "rotation" means.

---

## Migration of existing installs

### Installs that already have web-signed-up users

(PR #902-era installs where the operator signed up via `/sign-up`
with email + password.) These keep working **independently**. Their
better-auth credential rows are unchanged, their sign-in still works.

The install operator is added **alongside** them on next boot
(`ensureInstallOperator()` provisions the row if missing). The
existing humans don't lose access; the install operator is just an
additional system actor.

In single-user mode this means the deployment effectively has two
"users": the install operator (auth via ENCRYPTION_KEY) and the
one human (auth via their original password/passkey). The
single-user cap excludes the install operator (per the
`principal_kind` predicate above), so the human count stays at 1.

### Installs minted via the old `/api/local-init` anonymous-mint path

(Where a `user` row exists but has no credentials — only the
session+PAT minted by the legacy local-init.) Two-step migration:

1. `ensureInstallOperator()` adds the install operator row.
2. If the SPA detects `hasUser=true && noCredentials=true` for the
   pre-existing row, it routes that user to "Set a password" before
   showing UI (mirroring PR #917 Q5).

Both rows coexist; the operator can use either to sign in.

### Installs without an `ENCRYPTION_KEY` in `.env` yet

Pre-`lobu init` installs (dev checkouts that ran `make dev` directly
in the monorepo). The dev path uses
`LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1` to generate a per-boot key.
**Under v3, the install operator is provisioned with whatever value
the server boots with that session.** Restarting the server with a
fresh ephemeral key invalidates the operator's auth — which is
correct, since restarting also invalidates at-rest reads.

Dev contributors using `make dev` should set a real `ENCRYPTION_KEY`
in `.env.local` if they want sessions to survive reboots. This is
already true today for any at-rest-encrypted data; v3 just extends
"survive reboots" to "login survives reboots."

---

## Vault semantics — what changes

Today:
- `.env` `ENCRYPTION_KEY` decrypts at-rest secrets in `secret-proxy`,
  the secrets table, etc.
- Better-auth credentials are independent. Anyone with a valid
  password can sign in; ENCRYPTION_KEY isn't checked.

v3:
- `.env` `ENCRYPTION_KEY` decrypts at-rest secrets (unchanged).
- `.env` `ENCRYPTION_KEY` is also the install operator's password.
  Anyone who can produce it can sign in as the operator.
- The two properties are now coupled: lose `ENCRYPTION_KEY` → lose
  both. Rotate it → invalidate both.

This is the **vault property**. The auth credential and the
encryption credential are the same atom; v1 and v2 collapse into a
single design.

### What's still TODO (out of scope for v3)

v3 doesn't change how at-rest encryption works in `secret-proxy`
(packages/server/src/lobu/gateway.ts). The plumbing stays. The
**only thing v3 adds** is the install operator row + provisioning
hook + login-with-ENCRYPTION_KEY UX. The encryption code path is
untouched.

Future enhancements that this design enables but doesn't ship:
- OS keychain integration (macOS Keychain, Linux Secret Service,
  Windows DPAPI) — store `ENCRYPTION_KEY` outside `.env` per device.
- `MASTER_KEY` in-memory hardening (sealed boxes, `mlock`).
- Per-operator vault sub-keys (1Password Teams style).

None of these block v3 from shipping.

---

## Open questions

### Q1 — Menubar-first headless CLI handoff

**Scenario:** user installed via menubar, paste-the-secret + passkey
flow. Their `.env` is on the install host (somewhere they'd have to
SSH to). Now they want CLI access from a laptop without going
spelunking for `.env`.

**Option A** — menubar shows the install secret in settings under
"Connect another device." Operator copies it, pastes into
`lobu login --secret <value>` on the laptop. CLI persists to
`~/.lobu/contexts.json` as today.

**Option B** — generate a PAT from web settings, paste into
`lobu login --token <pat>` as today. Doesn't require exposing the
install secret.

**Recommendation: B is the default**, A is an opt-in convenience.
Showing the install secret in UI dilutes the "paste once per device"
discipline; PATs are cheaper to mint and revoke.

### Q2 — Multi-tenant admin bootstrap (CI / unattended deployments)

For headless `lobu apply` in CI, the deployer pastes `ENCRYPTION_KEY`
as a CI secret, the CLI signs in as the install operator, runs the
apply. Same flow as local — no separate admin token needed.

Operator security: `ENCRYPTION_KEY` in CI secrets is functionally
equivalent to a long-lived admin PAT. Operators who want a
revocable credential for CI mint a PAT from web settings and use
that instead; `ENCRYPTION_KEY` is the *bootstrap*, not the
*everyday-CI-secret*.

### Q3 — Recovery story

Today: losing `.env` means losing at-rest decrypt = total loss.
Under v3 that loss also invalidates auth (no new failure mode).
The recovery story is **whatever the operator already has for**
**`ENCRYPTION_KEY`** — backup, password manager, emergency kit
print-out.

The "recovery-key file at `lobu init`" idea from v2 (PR #917 Q2)
**dissolves**. There's no separate auth credential to recover
without the encryption key. Either you have the encryption key and
can sign in, or you don't and you've lost the data anyway.

This is the cleanest outcome of v3: one secret to back up, not two.

### Q4 — Email collisions in multi-tenant

Synthetic operator email `operator@<hostname>.local` could collide
in multi-tenant cloud installs (same hostname behind a load
balancer). Use `operator+<install_id_8>@lobu.local` instead — the
install_id is deterministic per deployment and avoids hostname
ambiguity. Reserved namespace (`@lobu.local` is non-routable; humans
can't sign up with that domain by accident — add a server-side
reject of `@lobu.local` in better-auth's signup path).

### Q5 — Better-auth password hashing

Better-auth's `account.password` column stores a hash. Default is
scrypt; switching to Argon2id is a known knob. v3 doesn't require
Argon2id specifically — the hash function is opaque to the design.
But Stage 2 implementation should standardise on Argon2id while
we're touching the auth surface (it's the modern default for new
designs), and persist the params on the account row so future-future
work has them available.

---

## Decision summary (5 bullets)

1. **`ENCRYPTION_KEY` from `.env` IS the install operator's
   password.** Same secret unlocks at-rest encryption (today) and
   gates auth (new). One irreplaceable secret, not two.
2. **`lobu init` doesn't prompt** — the secret is still generated
   randomly into `.env` as today. `lobu run` calls
   `ensureInstallOperator()` at boot, which idempotently provisions
   a `principal_kind='install_operator'` user with the hashed
   ENCRYPTION_KEY as their better-auth password.
3. **Humans never see the raw `ENCRYPTION_KEY` on GUI clients.**
   `lobu init` emits a one-time pairing URL (`~/.lobu/install/<id>/pairing.url`,
   mode 0600). Menubar / Chrome extension / second device open that
   URL → server validates the OTP, signs in as the install operator,
   redirects to credential enrolment (passkey or 4–6 digit passcode,
   or both). The passcode is a Keychain ACL over a stored PAT —
   **never a KDF input** — so its low entropy is fine. CLI is the
   only client that reads `ENCRYPTION_KEY` directly from `.env`.
4. **`/api/local-init` becomes a session-to-PAT exchange.** No
   anonymous mint. CSRF / loopback checks stay as defence-in-depth.
   The "zero users → /sign-up redirect" branch dies (operator is
   always present after first boot).
5. **v1 ≡ v2 vault.** No separate wrap-the-key step, no migration
   from v1 to v2, no extra recovery flow. The auth credential and
   the at-rest encryption key are the same value from day one.
   Key rotation = revoke everything (the desired vault property).

---

## In scope for Stage 2 implementation (NOT this PR)

1. **Server-side `ensureInstallOperator()`** in `start-local.ts`.
   Hash `ENCRYPTION_KEY` via better-auth's hasher, INSERT user +
   account, trigger existing `databaseHooks.user.create.after` for
   personal-org provisioning. Idempotent. Add `principal_kind`
   column (default `'human'`, value `'install_operator'` for this
   row).
2. **CLI `lobu login` default path**: read `.env`, POST to
   `/api/auth/sign-in/email` with synthetic email + ENCRYPTION_KEY,
   exchange session for PAT, persist to contexts.json. Existing
   `--token` path stays for PATs.
3. **OTP-pairing surface** (see "Device pairing: OTP URL flow"):
   - New `pairing_otps` table + migration (token PK, install_op_id
     FK, expires_at, used_at, created_at).
   - New `GET /auth/pair?token=<otp>` route: validate, atomically
     mark used, sign in as install operator, redirect to
     `/auth/enrol-credential` with `Referrer-Policy: no-referrer`.
   - `lobu init` writes `~/.lobu/install/<install-id>/pairing.url`
     (mode `0600`) alongside `.env`.
   - SPA settings: "Pair another device" mints a fresh OTP +
     renders URL/QR.
4. **Credential-enrolment route** (the OTP redirect target): offers
   **passkey + passcode** side-by-side (both, either, or skip).
   Inline form, no modal (per DESIGN_GUIDELINES §1 + §8). After
   enrolment, normal SPA loads. Passcode path is **macOS-only** in
   v3 (Keychain ACL + `kSecAttrAccessControlUserPresence`);
   Linux/Windows equivalents are future work. Web SPA: passkey-only.
5. **`/api/auth/config` returns `hasInstallOperator`** so the SPA
   knows to show "Connect this device" vs `/sign-up`.
6. **Exclude install operator from single-user-mode count** in
   `auth/index.tsx:567` and `auth/config.ts` `hasUser` query.
7. **Reject `@lobu.local` signups** server-side so the synthetic
   operator email namespace can't be squatted.
8. **`/api/local-init` reframe**: require a valid session cookie;
   remove "zero users" branch.
9. **E2E tests**: (a) `lobu init` → `lobu run` → `lobu login` works;
   (b) menubar opens `pairing.url` → OTP redeems → passkey/passcode
   enrolment works; (c) restart `lobu run` + `lobu login` still works
   (operator persists); (d) wrong `ENCRYPTION_KEY` → 401;
   (e) `/api/local-init` rejects unauthenticated callers;
   (f) replay of a used OTP → `410 Gone`; (g) expired OTP → `410 Gone`.

## Out of scope for Stage 2

- Key rotation tooling (operators do it via backup-restore for now).
- OS keychain integration for storing `ENCRYPTION_KEY` itself
  (the menubar passcode flow uses Keychain for the PAT, which is
  a different artifact).
- Linux Secret Service / Windows DPAPI equivalents for the
  passcode convenience path — macOS-first in v3.
- Cross-device passcode sync (each device keeps its own Keychain
  entry).
- Building our own rate-limited PIN store — Keychain ACLs already
  do this with hardware-backed throttling.
- `MASTER_KEY` in-memory hardening (sealed boxes, `mlock`).
- Per-operator vault sub-keys.
- The audit `[system]` label discussion from v2's doc — install
  operator events render with name "Install operator," no new
  badge.

---

## What previous revisions got wrong (kept for traceability)

- **v1 (install identity at boot, never landed):** trust boundary
  was network-topology, not cryptographic. Reviewers flagged "any
  same-host process can become Lobu." Abandoned.
- **v2 (password-at-init, this branch's first commit):** asked the
  operator to type a password at `lobu init`. Created two
  irreplaceable secrets (password + ENCRYPTION_KEY), needed a
  separate recovery story, and required a future "wrap-the-key"
  migration to land vault-grade encryption. v3 collapses both
  secrets into one.

The five-PR landing order from earlier still applies: this design
doc PR is #1 of 5. Coordinate with `scaffold-dx` on `.env` template
comments noting that `ENCRYPTION_KEY` is now the install secret;
coordinate with `build-hygiene` on the migration adding
`principal_kind` to `user`.
