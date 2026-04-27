# World Model — Consolidation (Apr 2026)

Companion to [`world-model.md`](./world-model.md). That doc describes the
**target architecture**; this one captures the **decisions, trade-offs,
and mid-flight corrections** made while consolidating the public
catalogs into that shape.

This PR ships the data move and the bug fixes that came up during the
work. The trust-claim machinery that originally shipped here was
stripped before merge — see "Trust layer: deferred to a connector-facts
engine" below for why and what replaces it.

## What shipped in this PR

- **`venture-capital`** + **`market-intelligence`** consolidated into a
  single public **`market`** org (rename + brand-merge), plus a sibling
  public **`atlas`** reference catalog. Sources archived
  (`visibility='archived'`), not deleted — owner retains access for
  recovery, non-members can no longer see them.
- **Live state in DB**: `market` has 125 entities (43 company, 23
  founder, 12 fund-round, 23 investor, 19 product, 5 sector), 393
  relationships including 291 remapped `mentions`, 287,648 events.
  `atlas` exists with schemas only; zero data.
- **Schemas in repo** (`examples/{atlas,market}/`): atlas with 7
  entity types (incl. `$member`); market with renamed YAMLs, brand
  fields on `company`, a new `job-posting` entity type, the recovered
  `mentions` relationship, and 5 cross-org relationship types
  (`headquartered_in`, `operates_in`, `educated_at`,
  `uses_technology`, `in_industry`).
- **OAuth scope-leak fix**: `mcp:admin` is now filtered out for
  non-owner roles at consent and device-approve. The filter returns
  `null` (instead of an empty string) when a non-empty request would
  otherwise produce an empty grant — callers reject with
  `invalid_scope` rather than silently storing empty-as-null and
  letting the verifier re-expand to default scopes (CodeQL/Codex P1).
- **`isolated-vm` Node 25 compat**: bumped 5.0.4 → 6.1.2; `.nvmrc`
  pinned to Node 22; root `engines: ">=22 <25"`.
- **Submodule UI** (`lobu-ai/owletto-web` PR #43): public catalog
  browse routes (read-only) — ships in its own pair of PRs after #414
  merges, per the submodule rule.

## Architectural decisions

### 1. Two orgs (`atlas` + `market`), not one, not five

Considered: 1 mega-org (everything), 2 (current), 3+ (jobs as own org).

Picked **2** because:
- One mega-org bundles slow-changing reference data (cities,
  industries) with churny commercial data (companies, jobs). A schema
  migration on `company` shouldn't risk touching `city`.
- Five+ orgs (jobs separate, etc.) is over-fragmentation for current
  scale — 22 companies, 0 jobs.
- The 2-split aligns with how Owletto's cross-org rules already work:
  `validateScopeRule` lets one public catalog reference any other
  public catalog, so the composition is native.
- Future siblings (e.g. `realestate`) ride alongside as a third
  sibling org. The 2-org architecture scales to N.

### 2. Names: `atlas` for reference, `market` for active

Picked **`atlas` + `market`**. Codex pushed back on `tech` (too narrow
— biotech, consumer, industrial squeezed out) and `world` (bland).
`market` is the broadest accurate framing of the company / labor /
capital graph without overclaiming. `atlas` reads as "the canonical
reference world".

### 3. Fresh `market` org, not slug-renaming `venture-capital`

The plan originally said "rename `venture-capital` → `market`".
Changed mid-session to **create new orgs and copy data**, leaving
the source orgs intact (then archived) for recoverability. The copy
approach gave a verification gate — counts before/after; user signs
off; then archive sources. The 313-mention loss was caught because
we could compare independent rows.

### 4. `$member` entities NOT copied; events ARE

`$member` auto-provisions per-org from the `user` table. Copying
them would create duplicates that the auto-provision logic would
reject or override. Skipping them was correct.

Events that referenced both a `$member` and a non-member entity
(most saved-knowledge events on companies / brands) were copied with
the `$member` reference dropped from `entity_ids`. The semantic
content is preserved; only the actor link is lost.

The 313 `mentions` relationships that pointed `*→$member` were
dropped in the original migration and recovered later via a separate
remap pass (291/313 succeeded; 20 were `*→$member` for users not yet
in `market`, 2 were cross-org duplicates).

### 5. Brand-merge: 0 fuzzy auto-merges

Domain match + Jaro-Winkler fuzzy name match was the original design.
When run live: 0 brands matched any existing VC company. All 21
became fresh `market.company` rows. `venture-capital` was
technical-startup-focused; `market-intelligence` had consumer-brand
entries. The matcher ran in a one-off script that was deleted from
the repo after running. The code didn't ship.

### 6. Trust layer: deferred to a connector-facts engine

This is the biggest mid-flight correction. The original Phase 5
design was an LLM-driven audit agent with 5-tier evidence grading.
That was killed as overengineering. The Phase 4 platform primitives
(`claims_identity` / `has_authority` relationship types,
`entity_read_grant` table, `provider-metadata-sync` hook, audit-agent
service user) shipped in earlier commits on this branch but were
**stripped before merge** — they had no readers, the audit agent
that consumed them was dead, and a cleaner replacement is queued
behind this PR.

**The replacement (follow-up PR):** a connector-facts engine, where
facts are just a `semantic_type` of the existing `events` table.

- Connectors emit durable **fact-typed events**: each fact is a row
  in `events` with `semantic_type='identity_fact'`,
  `entity_ids=[$member]`, and `metadata={namespace, normalized_value,
  assurance, provider_stable_id, valid_to}`. Refresh writes a new
  event that supersedes the old via `supersedes_event_id`; the
  existing `current_event_records` view shows only live facts.
- Public-catalog YAMLs declare which entity-type fields participate
  in identity lookup (`identity_namespace:`) and which relationship
  types auto-create from which fact namespaces (`auto_create_when:`).
- A generic engine reads fact-typed events + compiled-rule rows and
  writes derivations: each auto-created relationship carries
  provenance (which event, which rule version) so revocation is
  exact.
- Adding a new connector or a new claim type is data-only — write a
  connector that emits fact events, or edit YAML to declare a new
  rule. The platform code never changes.

The same machinery also handles bringing in user contacts, followings,
and emails: those land as `semantic_type='content'` events through
the existing connector path. One mental model, one supersede
mechanism, one query path.

What this approach inherits from the killed Phase 4/5:
- Provider-verified identity (Google email / hosted_domain, GitHub
  username, LinkedIn URL) is still the trust signal.
- Per-org `$member` adoption is still the people-identity model — no
  separate `founder` entity type once the migration runs.

What it explicitly drops:
- 5-tier evidence grading (always-`B` for OAuth-verified is enough;
  middle tiers were academic).
- `claims_identity` / `has_authority` as separate relationship types
  (replaced by general-purpose relationships like `works_at`,
  `is_admin_of`, `manages` driven by rules).
- `entity_read_grant` table + audit-agent service user (no consumer).
- Manual claim flow with `status='pending'` (no reviewer).
- LLM evaluator for spam moderation (premature; 0 contribution
  volume).

The full design — five primitives (facts, identity index, compiled
rules, derivations, reconcile queue), use cases, edge cases, and
phased rollout — lives in the in-repo design plan and ships as PR
#414's follow-up.

### 7. Atlas data seeding deferred

Atlas has zero data. The original plan included one-shot seeders for
ISO-3166 countries, GeoNames cities, NAICS industries, etc. The
seeders were 6,000+ lines of throwaway code, so they ran as `/tmp`
scripts and were deleted. For atlas specifically, no seeding was
done — atlas can be populated organically as cross-org references
arrive, or via a future one-off run when there's actual demand.

**Trade-off:** today, no `market.company` can reference an
`atlas.city` because no atlas cities exist. This is fine for v1 —
companies have location strings in their existing metadata; the
cross-org relationship to atlas is a v2 feature pending atlas being
populated.

### 8. Two-PR submodule rule

Phase 7 UI lives in `packages/owletto-web` submodule. Per repo
convention, every submodule change ships as two PRs: the submodule
PR (merged first) and a parent-bump PR pinning the new SHA. So:
PR #43 against `lobu-ai/owletto-web` is the UI ship. After it
merges, a small parent-bump PR completes the rollout.

## Critical files for the review agent

| Concern | File |
| --- | --- |
| Org rename / archive surface | direct DB SQL (no committed migration) |
| Schemas | `examples/atlas/models/`, `examples/market/models/` |
| Cross-org rules | `packages/owletto-backend/src/utils/relationship-validation.ts:72-111` |
| OAuth scope filter | `packages/owletto-backend/src/auth/oauth/scopes.ts` (`filterScopeByRole`) |
| OAuth consent path | `packages/owletto-backend/src/auth/oauth/routes.ts` |
| Trust-primitive revert | `db/migrations/20260427130000_drop_trust_primitives.sql` |
| Browse routes (submodule) | `packages/owletto-web/src/app/$owner/browse/` |
| Discover route | `packages/owletto-web/src/app/discover.tsx` |
| Org switcher (with public-catalog distinction) | `packages/owletto-web/src/components/sidebar/organization-dropdown.tsx` |

## Things deliberately deferred to follow-up PRs

- **Connector-facts engine** (the trust-layer replacement) — own PR.
  Founder→`$member` migration ships there too.
- **Atlas data seeding** — when there's a referencing use case.
- **Phase 7 interactive UI** (claim button, job submission, admin
  pending queue) — after browse-only ships.
- **Schema-declared claim mapping** (was task #13) — folded into the
  facts-engine YAML declarations; the standalone task is closed.
