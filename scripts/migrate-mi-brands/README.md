# Brand-merge migration (`market-intelligence` → `market.company`)

One-time migration that consolidates the public `market-intelligence`
catalog into `market`, the renamed venture-capital catalog. Phase 3 of
the world-model consolidation — runs *after* Phase 1 (rename + atlas
schemas) and Phase 2 (atlas seeding) have landed.

For each `market-intelligence.brand`, the script tries to identify the
matching `market.company` and merges the brand's distinguishing fields
(`logo_url`, `tagline`, `brand_voice`, `social_handles`) into it. If
nothing matches, the brand becomes a new `market.company`. After every
brand has been processed, `market-intelligence.mentions` relationships
are re-pointed at the corresponding `market.company`.

The script never deletes anything in `market-intelligence`. Archiving
the source org is a one-line SQL the operator runs **after** verifying
the migration output.

## Run order

This script assumes:

1. The `venture-capital` → `market` rename has been applied
   (`scripts/migrate/rename-vc-to-market.sql`).
2. The `atlas` org exists (`scripts/migrate/create-atlas-org.sql`).
3. `examples/atlas/` and the renamed `examples/market/` schemas have
   been pushed.
4. **Run the brand-merge in dry-run.** Review the audit log.
5. **Re-run with `--apply`** once the dry-run looks correct.
6. **Manually archive `market-intelligence`** — the script prints the
   exact SQL but does *not* execute it.

## Usage

```bash
# Default: dry-run. No writes. Same output the --apply run would emit.
bun run scripts/migrate-mi-brands/index.ts

# Cap brands processed for a smoke run.
bun run scripts/migrate-mi-brands/index.ts --limit=10

# Restrict matching to one strategy.
bun run scripts/migrate-mi-brands/index.ts --match-only=domain
bun run scripts/migrate-mi-brands/index.ts --match-only=name

# Tune the fuzzy threshold (default 0.92).
bun run scripts/migrate-mi-brands/index.ts --threshold=0.95

# Live run — writes to market. Always pair with operator review.
bun run scripts/migrate-mi-brands/index.ts --apply
```

CLI flags:

| Flag                     | Default              | Meaning                                                                                  |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `--apply`                | (off → dry-run)      | Make writes. Without this every code path is a dry-run.                                  |
| `--dry-run`              | (default)            | Explicit dry-run. Wins when both `--apply` and `--dry-run` are passed.                   |
| `--limit=N`              | unlimited            | Stop after the first `N` brands. Must be a positive integer.                             |
| `--match-only=<mode>`    | `both`               | Restrict matching to `domain`, `name`, or run `both`.                                    |
| `--threshold=<float>`    | `0.92`               | Jaro-Winkler threshold for fuzzy name matching. Below threshold → no-match → create.     |
| `--source-org=<slug>`    | `market-intelligence`| Override the source org slug. Useful for staging.                                        |
| `--target-org=<slug>`    | `market`             | Override the target org slug.                                                            |

Unknown flags are rejected so typos can't silently flip the behavior.

## Environment

```
OWLETTO_BASE_URL    e.g. https://owletto.example.com
OWLETTO_API_TOKEN   PAT or OAuth bearer with read on the source org and
                    write on the target org
```

The script talks to the same `POST /api/{orgSlug}/manage_entity`
tool-proxy the Atlas seeders use; cross-org access is just two `OrgClient`
instances pointed at different slugs.

## Matching

Two strategies, applied in order:

### 1. Domain match (preferred)

The brand's domain is canonicalized — protocol stripped, `www.`
removed, lowercased, port + path dropped. Then we look up
`market.company` entities with the same canonical domain. Fields
inspected on each side:

```
metadata.primary_domain → metadata.domain → metadata.homepage_url
                       → metadata.website → metadata.website_url → metadata.url
```

A *single* exact-domain match wins. Multiple companies on the same
canonical domain → ambiguous; the brand is logged and skipped.

### 2. Fuzzy name match (fallback)

When the brand has no usable domain (or no company shares it), names
are normalized:

- lowercased
- diacritics stripped
- non-alphanumerics collapsed to spaces
- common company suffixes stripped: `Inc`, `Incorporated`, `LLC`, `Ltd`,
  `Limited`, `Co`, `Corp`, `Corporation`, `Company`, `GmbH`, `AG`,
  `SA`, `PLC`, `BV`, `NV`, `OY`, `AB`, `KG`, `KK`

Then the normalized brand name is scored against every company's
normalized name with **Jaro-Winkler** similarity (standard 0.1 prefix
scaling, prefix capped at 4 chars). The single highest-scoring company
above the threshold wins. Any *tie* at the top is treated as ambiguous.

**Default threshold is 0.92.** Brands below threshold are treated as
no-match and become new `market.company` rows. The audit log carries
the brand's best fuzzy score on the `created` decision so operators
can spot near-misses that arguably should have merged.

## Merge contract

When a match is found, only the brand fields *missing* on the company
are filled in. Existing values are never overwritten. Fields covered
(per `examples/market/models/company.yaml`):

- `logo_url`
- `tagline`
- `brand_voice`
- `social_handles.{twitter, linkedin, github, youtube, instagram, tiktok}`

Each `social_handles` subkey is filled independently — if the company
already has a `twitter` but not a `linkedin`, the merge fills the
`linkedin` and leaves `twitter` alone.

When **no match exists**, a new `market.company` is created carrying
only the brand fields above (plus `primary_domain` if MI had one). The
new company's `name` and `slug` come straight from the brand.

## Mention re-targeting

After the brand pass, the script walks every brand → company mapping
and re-creates `market-intelligence.mentions` relationships in the
target org pointing at the merged / created company. The original
relationships in MI are left in place — archiving the source org is the
operator's final step.

For mentions whose source brand was **ambiguous / skipped**, no
re-target happens — the audit log records `mention-skipped` so the
operator can resolve manually before archiving MI.

For mentions whose **other side** (the content entity) has no
counterpart in `market`, the link is also skipped. The first pass of
this migration only re-targets the brand side; mirroring MI content
into `market` is a follow-up.

## Idempotency

Re-running the script is safe — every operation is a no-op when the
target state already matches:

- `merge` only fills in missing fields. A second run on the same
  company sees those fields populated and emits `noop`.
- `create` runs only when the brand has no match. Once a company has
  been created, the next run finds it (by domain or fuzzy name) and
  takes the merge path instead.
- Mention re-targeting dedupes: before creating a `mentions` link in
  the target org, the script lists existing `mentions` on the target
  company side and skips the `link` call if an equivalent edge already
  exists. The audit log records `mention-retargeted (target already
  has equivalent mentions link (noop))` so operators can confirm the
  pass converged.

The audit log itself is append-only and includes `dry_run: true|false`
on every entry, so prior runs are clearly distinguishable.

## Audit log

Every decision lands in `scripts/migrate-mi-brands/logs/` as a single
JSONL file per run. Filename:

```
migrate-{dryrun|apply}-<ISO-timestamp>.jsonl
```

One line per decision. Schema:

```json
{
  "ts": "2026-04-27T12:34:56.000Z",
  "decision": "merged-domain | merged-name-fuzzy | created |
               ambiguous-skipped | create-failed | merge-failed |
               mention-retargeted | mention-skipped | noop",
  "brand_id": 42,
  "brand_name": "Acme",
  "brand_slug": "acme",
  "company_id": 17,
  "company_name": "Acme Corporation",
  "company_slug": "acme-corp",
  "score": 0.94,
  "candidate_ids": [17, 23],
  "mention_id": 9001,
  "dry_run": true,
  "reason": "filled logo_url, tagline"
}
```

## Final operator step

After the live `--apply` run completes and the audit log is reviewed:

```sql
UPDATE organization
SET visibility = 'archived'
WHERE slug = 'market-intelligence';
```

The script prints this exact SQL at the end of every run. It is **not**
executed by the script — archiving is your call.

## Tests

```bash
bun test scripts/migrate-mi-brands/__tests__
```

All tests are fixture-driven with a mock `OrgClient`. They cover:

- domain canonicalization (URL forms, `www.`, ports, paths, malformed)
- name normalization (suffixes, diacritics, punctuation)
- Jaro-Winkler against curated pairs
- domain match + fuzzy match + ambiguous skip + below-threshold skip
- merge precedence (existing values preserved, missing values filled)
- end-to-end run on a synthetic 5-brand / 3-company corpus, confirming
  the dry-run vs apply split and idempotent re-run
