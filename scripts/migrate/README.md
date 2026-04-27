# scripts/migrate

One-shot SQL migrations the operator runs by hand against production after
the corresponding code PR merges. Idempotent — safe to re-run.

## Run order

### Phase 1

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

### Phase 4

3. **`seed-proposal-inboxes.sql`** — provision one `_proposal_inbox`
   sentinel entity for `atlas` and `market`. Re-run after each org's
   `_proposal_inbox` entity type is registered (the backend's
   entity-type editor reads `examples/{atlas,market}/models/_proposal_inbox.yaml`).
   The script no-ops cleanly when the type is missing, so it's safe to
   run before registration completes.

## How to run

```sh
psql "$DATABASE_URL" -f scripts/migrate/rename-vc-to-market.sql
psql "$DATABASE_URL" -f scripts/migrate/create-atlas-org.sql
psql "$DATABASE_URL" -f scripts/migrate/seed-proposal-inboxes.sql
```

Verify each script's effect with the queries embedded as comments at the
top of the file.
