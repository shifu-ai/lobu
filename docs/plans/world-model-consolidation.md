# World Model — Consolidation (Apr 2026)

Companion to [`world-model.md`](./world-model.md). That doc describes the
**target architecture**; this one captures the **decisions, trade-offs, and
mid-flight corrections** made while consolidating the public catalogs into
that shape.

This doc exists to be challenged. A reviewer should be able to read it and
ask "why?" against every choice. Where I changed my mind during the work,
that's called out explicitly.

## What shipped

- **`venture-capital`** + **`market-intelligence`** consolidated into a
  single public **`market`** org (rename + brand-merge), plus a sibling
  public **`atlas`** reference catalog. Sources archived
  (`visibility='archived'`), not deleted — owner retains access for
  recovery, non-members can no longer see them.
- **Live state in DB**: `market` has 125 entities (43 company, 23 founder,
  12 fund-round, 23 investor, 19 product, 5 sector), 393 relationships
  including 291 remapped `mentions`, 287,648 events. `atlas` exists with
  schemas only; zero data.
- **Two PRs**:
  - `lobu-ai/lobu` PR #414 — schemas + platform primitives + bug fixes.
  - `lobu-ai/owletto-web` PR #43 — public catalog browse routes (read-only).
  - Parent submodule-pointer bump pending after #43 merges.

## Architectural decisions and the reasoning behind each

### 1. Two orgs (`atlas` + `market`), not one, not five

Considered: 1 mega-org (everything), 2 (current), 3+ (jobs as own org).

Picked **2** because:
- One mega-org bundles slow-changing reference data (cities, industries) with
  churny commercial data (companies, jobs). A schema migration on `company`
  shouldn't risk touching `city`. Different audit cadences too.
- Five+ orgs (jobs separate, etc.) is over-fragmentation for current scale —
  22 companies, 0 jobs. Operational overhead without payoff.
- The 2-split aligns with how Owletto's cross-org rules already work:
  `validateScopeRule` lets one public catalog reference any other public
  catalog, so the composition is native.
- Future siblings (e.g. `realestate`) ride alongside as a third sibling
  org, not as additions to `market`. The 2-org architecture scales to N.

**Reviewer challenge to anticipate:** "Why not just one mega-org?" Answer:
audit-agent / contribution policy is per-org and they differ between
reference data (no identity claims valid; nobody owns London) and active
data (identity claims drive everything). Splitting at that seam was real.

### 2. Names: `atlas` for reference, `market` for active

Considered: `world` / `atlas` / `places` / `reference` for reference;
`tech` / `companies` / `commerce` / `market` / `graph` for active.

Picked **`atlas` + `market`**. Codex pushed back on `tech` (too narrow —
biotech, consumer, industrial squeezed out) and `world` (bland). `market`
is the broadest accurate framing of the company / labor / capital graph
without overclaiming. `atlas` reads as "the canonical reference world".

Real estate as a future sibling won't conflict — it gets its own slug
(`realestate`) and has different primitives (property, listing,
transaction). The slug `market` reads as "market-of-companies" in context.

### 3. Fresh `market` org, not slug-renaming `venture-capital`

The plan originally said "rename `venture-capital` → `market`". I changed
this mid-session at the user's direction: **create new orgs and copy
data**, leaving the source orgs intact (then archived) for recoverability.

Why this matters:
- The rename was a single SQL UPDATE. Reversible but the original ID
  collision check would have made it harder to recover if anything went
  wrong.
- The copy approach gives a verification gate — counts before/after; user
  signs off; then archive sources.
- Source orgs are still queryable by the owner via direct DB or per-org
  membership. If something is missed in `market`, recoverable.

**Reviewer challenge to anticipate:** "Why duplicate data instead of
renaming?" Answer: data integrity gate. We caught the 313-mention loss
because we could compare before/after counts on independent rows. With a
rename we'd have flipped the slug and lost that gate.

### 4. `$member` entities NOT copied; events ARE

`$member` auto-provisions per-org from the `user` table. Copying them
would create duplicates that the auto-provision logic would then reject or
override. Skipping them was correct.

But events that referenced both a `$member` and a non-member entity (most
saved-knowledge events on companies / brands) were copied with the
`$member` reference dropped from `entity_ids`. The semantic content is
preserved; only the actor link is lost.

The 313 `mentions` relationships that pointed `*→$member` were dropped in
the original migration and recovered later via a separate remap pass
(291/313 succeeded; 20 were `*→$member` for users not yet in `market`,
2 were cross-org duplicates).

**Trade-off:** event provenance ("who first observed this") was partially
lost. For a v1 public catalog this is acceptable — the canonical entity
data is what matters; provenance can be reconstructed from source if ever
needed.

### 5. Brand-merge: 0 fuzzy auto-merges; all 21 MI brands → new market.company

Domain match + Jaro-Winkler fuzzy name match was the original design
(Phase 3, before scope-cut). When run live: 0 brands matched any existing
VC company. All 21 became fresh `market.company` rows.

That's because `venture-capital` was technical-startup-focused, while
`market-intelligence` had consumer-brand entries. No real overlap. The
fuzzy logic was correct but had nothing to fuzz.

**Reviewer challenge:** "Why is there fuzzy matching code at all if
nothing matched?" Answer: at decision time we couldn't know. The matcher
ran in a one-off script that was deleted from the repo after running. The
code didn't ship.

### 6. Trust model: provider-metadata-sync, no audit agent

This is the biggest mid-flight correction. The original Phase 5 design
was an LLM-driven audit agent with 5-tier evidence grading. I admitted
this was overengineering and dropped it.

**What ships:**
- Provider-metadata-sync runs on every OAuth sign-in, queries the user's
  verified provider data (email, github username, linkedin URL, hosted
  domain, MS tenant, github org), and auto-creates `claims_identity` /
  `has_authority` relationships from the user's `$member` to matching
  `market` entities. These auto-accept (`status='active'`,
  `evidence_tier='B'`) because the OAuth provider already verified the
  identity.
- Manual claim creation (via `manage_entity.link`) defaults to whatever
  metadata the caller passes. For non-OAuth-verified contributors, that
  means `status='pending'` and an admin reviews it later.
- An `entity_read_grant` primitive lets the audit-agent service user (or
  a human admin reviewing a pending claim) read the contributor's private
  `$member` to verify. Issued by the relationship-creation hook;
  idempotent; expires in 30 days.

**What was rejected and why:**
- 5-tier evidence grading (Tier A through E): for a deterministic OAuth
  match the grade is always B. For unverified manual claims the grade is
  unknowable without external evidence. The middle tiers were academic.
- `proposes_canonical` / `proposes_merge_with` relationship types: these
  were designed for "contributor proposes a new public entity / proposes
  a merge". For v1, atlas + market are admin-curated. No public flow for
  non-admins to propose new entities yet.
- LLM evaluator for spam moderation: 0 contribution volume today, can be
  added later if/when there's load.
- A separate `audit_log` table: decisions live as events on the affected
  entity (`semantic_type='change'` with verdict metadata). Reuses
  existing primitives.

**Reviewer challenge to anticipate:** "Why have `claims_identity` AND
`has_authority` instead of one type?" Answer: identity is durable
("I am Albert Pai"); authority is temporal ("I can edit Bolt.new's
profile, while employed there"). Conflating them creates the founder-leaves-
company rights bug — codex flagged this in the architectural review. They
need to revoke independently.

### 7. Field-name mappings are HARDCODED today (and we know it's brittle)

`provider-metadata-sync.ts` has hardcoded queries for each
(provider field → entity-type slug → metadata field name) tuple. This is
why `primary_domain` vs `domain` is a real bug today — code looks for
`primary_domain`, migrated companies have `domain`.

Filed as task #13 for v2: schema-declared `x-claim-via` annotations on
entity-type metadata fields. Each public catalog declares its own claim
contract in YAML. Sync becomes generic.

**Why not fix it in #414:** v1 works for the 8 founders with `linkedin_url`
populated. The fix is a real refactor (annotation parsing,
normalizer whitelist, security review of the dynamic-query engine) and
doesn't block ship. Tracked separately.

### 8. Atlas data seeding deferred

Atlas has zero data. The original plan included one-shot seeders for
ISO-3166 countries, GeoNames cities, NAICS industries, etc.

**Why deferred:** the seeders were 6,000+ lines of code. The user
correctly pushed back on committing throwaway one-off code to the repo.
The seeders ran as `/tmp` scripts during the migration and were deleted.
For atlas specifically, no seeding was done — atlas can be populated
organically as cross-org references arrive, or via a future one-off run
when there's actual demand.

**Trade-off:** today, no `market.company` can reference an `atlas.city`
because no atlas cities exist. This is fine for v1 — companies have
location strings in their existing metadata; the cross-org relationship
to atlas is a v2 feature pending atlas being populated.

### 9. Two-PR submodule rule, not one

Phase 7 UI lives in `packages/owletto-web` submodule. Per repo
convention, every submodule change ships as two PRs: the submodule PR
(merged first) and a parent-bump PR pinning the new SHA. This rule
exists because production resolves the submodule SHA from the parent;
pushing a parent commit referencing an unmerged submodule SHA breaks
prod.

So: PR #43 against `lobu-ai/owletto-web` is the UI ship. After it
merges, a small parent-bump PR completes the rollout.

## Gaps the review agent should challenge

These are real and named:

1. **Field-name mismatch — `primary_domain` vs `domain`.** 0 of 43
   companies have `primary_domain`; 20 have `domain`. Provider-sync
   queries `primary_domain` exclusively. So Google Workspace + Microsoft
   tenant claim matches WILL fail today. Two-line fix: also query
   `domain` as a fallback. Or do the schema-declared mapping refactor
   (#13) and put both in YAML.

2. **URL canonicalization on LinkedIn match.**
   `e.metadata->>'linkedin_url' = ${linkedinUrl}` — exact string match.
   `https://www.linkedin.com/in/x` !== `https://linkedin.com/in/x` !==
   `https://linkedin.com/in/x/`. Three should match. Need a `normalize`
   step before comparison.

3. **Founder `contact_email` not populated.** 0 of 23 founders. Until
   backfilled, Google email-match auto-claim is dead.

4. **Founder `github_handle` not populated.** Same.

5. **Better Auth LinkedIn provider config.** Need to confirm
   `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` are wired in env and
   the userinfo endpoint actually returns the `profile` field that
   provider-sync reads.

6. **Manual claim flow has no UI.** For founders without `linkedin_url`,
   or for users whose provider isn't wired — there's no button. They'd
   have to call the MCP `manage_entity.link` directly. Phase 7
   interactive (claim button) is deferred.

7. **No write-time authority enforcement** in `manage_entity.handleCreate`.
   If a non-admin member ever joins a public catalog, they can write
   entities directly without checking `has_authority`. Today the public
   orgs have no non-admin members; if/when they do, this is a gap.

8. **`isolated-vm` Node 25 doesn't work locally.** The bug-fix bumped
   to v6.1.2 + pinned Node 22 via `.nvmrc`, but if the developer is
   running Node 25 they still hit the load failure. Workaround
   documented; root upstream fix pending in `laverdet/isolated-vm`.

## Things deliberately NOT done

- Atlas data seeding (intentionally empty for v1).
- Phase 6 write-time authority enforcement (no contributors yet).
- Phase 7 interactive UI (claim button, job submission, admin pending
  queue) — deferred to a follow-up after browse-only ships.
- Audit agent LLM module — overengineering; killed mid-implementation.
- `proposes_canonical` / `proposes_merge_with` / `_proposal_inbox`
  sentinel entities — overengineering; deleted.
- Schema-declared claim mapping (#13) — known gap, not a v1 blocker.
- Switching providers' OAuth scope-request to include `mcp:admin` by
  default for owners — backend filter shipped (only owners get admin),
  but the CLI consent UX still doesn't pre-check the box. Cosmetic.

## Critical files for the review agent

| Concern | File |
| --- | --- |
| Org rename / archive surface | direct DB SQL (no committed migration) |
| Schemas | `examples/atlas/models/`, `examples/market/models/` |
| Cross-org rules | `packages/owletto-backend/src/utils/relationship-validation.ts:72-111` |
| Read-grant primitive | `packages/owletto-backend/src/utils/entity-read-grant.ts` |
| Read-grant issuance hook | `packages/owletto-backend/src/utils/entity-read-grant-hook.ts` |
| Provider-metadata sync | `packages/owletto-backend/src/auth/provider-metadata-sync.ts` |
| OAuth scope filter | `packages/owletto-backend/src/auth/oauth/scopes.ts` (`filterScopeByRole`) |
| OAuth consent path | `packages/owletto-backend/src/auth/oauth/routes.ts` |
| Browse routes (submodule) | `packages/owletto-web/src/app/$owner/browse/` |
| Discover route | `packages/owletto-web/src/app/discover.tsx` |
| Org switcher (with public-catalog distinction) | `packages/owletto-web/src/components/sidebar/organization-dropdown.tsx` |

## What I'd ask if I were reviewing this

These are the questions I'd push back on:

1. *"Do we need `entity_read_grant` at all? If the audit-agent LLM is
   killed, what consumes the grant?"* — Grants are consumed by the human
   admin reviewing a pending claim, via the (yet-to-build) Phase 7 admin
   UI. If we never build that UI either, the grant primitive is dead
   weight. **Worth challenging.**

2. *"Why two relationship types `claims_identity` + `has_authority`
   instead of one with `kind` metadata?"* — Codex argued separation;
   identity is durable, authority is temporal. But a single type with
   `kind: identity | authority` and conditional metadata could work and
   halves the schema. **Reasonable to push back on.**

3. *"Why `proposes_canonical` was so complex it justified a sentinel
   inbox entity per org?"* — It was. I deleted it. Good call to push
   back; that's already done.

4. *"Why isn't the audit-agent module fully deleted from the codebase?"*
   — It is, as of commit `8481352d`. The `entity_read_grant` primitive
   stays but its consumer (the LLM agent) doesn't.

5. *"Why are the `examples/{atlas,market}/models/` YAMLs even checked in?
   Couldn't they live in the DB and be loaded by the seed CLI without
   committing files?"* — They could. The repo convention is YAML-as-source
   (the `examples/*/lobu.toml` + `models/` pattern is how `agent-community`
   and `careops` already work). Switching to DB-only would be a wider
   refactor across all example orgs. **Worth challenging if simplification
   is the goal.**

6. *"Why does `provider-metadata-sync` run on every sign-in and refresh?"* —
   To keep `valid_to` extended and revocation prompt. Could be lazier
   (only on first sign-in + on demand) at the cost of staler authority
   state. **Worth a discussion.**

7. *"Is the `personal-org-provisioning` hook actually firing for every
   new sign-up, including users who came in via `market` directly? If
   not, the provider-sync `members` query returns empty and no claims
   happen."* — Pre-existing hook from before this work; assumed working
   but not re-verified in this session. **Worth verifying.**

## Suggested simplifications the review agent could pursue

In rough priority order (most impactful first):

1. **Drop `entity_read_grant` primitive** if the only consumer was the
   killed audit agent. Without an admin UI consuming it, it's a table
   that nobody reads. ~150 lines of code + a migration. Removable.

2. **Merge `claims_identity` + `has_authority` into one
   `claim` relationship type with `kind` metadata.** Halves the schema;
   simplifies the `TRUST_PRIMITIVE_RELATIONSHIP_SLUGS` check.

3. **Inline `provider-metadata-sync.ts` into the auth middleware.**
   Today it's a dedicated file with a public entry point. The flow is
   small enough that a sync function next to the BetterAuth hook would
   be just as readable.

4. **Schema-declared claim mapping (#13)** if the codebase is going to
   add more provider integrations. Without it, every provider/field
   addition is a code edit.

5. **Drop the `_audit_agent_user_id`-as-platform-service-user
   pattern.** With no audit agent, the service user is unused. Read
   grants could grant directly to org owners instead.

End of doc. The review agent should treat every decision above as
challenge-able.
