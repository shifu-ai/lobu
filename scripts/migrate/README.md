# scripts/migrate

One-shot SQL migrations the operator runs by hand against production after
the corresponding code PR merges. Idempotent — safe to re-run.

## Run order (Phase 1)

1. **`rename-vc-to-market.sql`** — flip the `venture-capital` org's slug
   to `market` and the display name to `Market`. Run **after** the code
   PR (`feat: rename venture-capital → market + create atlas org`)
   reaches production. Foreign keys are by id, so entity / member /
   event / relationship rows do not move.

2. **`create-atlas-org.sql`** — create the new public sibling
   `atlas` org. Run **after** step 1 (so the rename is complete and
   no two `Market`-style siblings exist mid-migration). Subsequent PRs
   register Atlas entity types and seed reference data; this script
   only inserts the org row.

## How to run

```sh
psql "$DATABASE_URL" -f scripts/migrate/rename-vc-to-market.sql
psql "$DATABASE_URL" -f scripts/migrate/create-atlas-org.sql
```

Verify each script's effect with the queries embedded as comments at the
top of the file.
