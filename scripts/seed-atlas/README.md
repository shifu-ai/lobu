# Atlas seed scripts

Idempotent seeders for the `atlas` reference catalog. Atlas is the public,
slow-churn world-knowledge layer (countries, regions, cities, industries,
technologies, universities) that other public catalogs (e.g. `market`)
reference via cross-org relationships.

The schemas these seeders write into live in
[`examples/atlas/models/`](../../examples/atlas/models/). Run order matches
the topological dependency order so cross-entity FKs resolve.

## Prerequisites

1. The `atlas` org must exist. Apply
   [`scripts/migrate/create-atlas-org.sql`](../migrate/create-atlas-org.sql)
   to your Owletto database first.
2. The Atlas entity types must be installed. Push
   [`examples/atlas/`](../../examples/atlas/) via the Owletto CLI (or sync
   from the YAMLs into the DB by whatever path you use for other catalogs).
3. Environment:
   - `OWLETTO_BASE_URL` — e.g. `https://owletto.example.com`
   - `OWLETTO_API_TOKEN` — PAT or OAuth bearer token with write scope on
     the `atlas` org
   - `ATLAS_RATE_LIMIT` *(optional)* — requests/sec ceiling. Defaults to
     50. Lower this if your Owletto instance starts pushing back.

## Usage

```bash
# Full seed
bun run scripts/seed-atlas/index.ts

# Smoke-run — log proposed payloads, no API calls
bun run scripts/seed-atlas/index.ts --dry-run --limit=5

# Subset (any combination of: countries, regions, cities, industries,
# technologies, universities)
bun run scripts/seed-atlas/index.ts --only=countries,cities
```

Each seeder can also be run on its own:

```bash
bun run scripts/seed-atlas/countries.ts --dry-run --limit=5
```

## Data sources

| Seeder         | Source                                                                                          | Observed count |
| -------------- | ----------------------------------------------------------------------------------------------- | -------------- |
| `countries`    | [`lukes/ISO-3166-Countries-with-Regional-Codes`](https://github.com/lukes/ISO-3166-Countries-with-Regional-Codes) | 249            |
| `regions`      | [`olahol/iso-3166-2.json`](https://github.com/olahol/iso-3166-2.json) — top-50 countries by population | 1 871          |
| `cities`       | [GeoNames `cities1000.zip`](https://download.geonames.org/export/dump/cities1000.zip), filtered to population ≥ 50k | ~12 000        |
| `industries`   | [Census Bureau NAICS 2022 6-digit XLSX](https://www.census.gov/naics/2022NAICS/6-digit_2022_Codes.xlsx) — leaf codes from Census, parents synthesized | 2 129          |
| `technologies` | Curated inline list in [`technologies.ts`](./technologies.ts)                                   | 217            |
| `universities` | [`Hipo/university-domains-list`](https://github.com/Hipo/university-domains-list) — fallback for WHED, which is license-encumbered | ~10 000        |

Cached datasets land in `./data/` and are reused on re-runs (30–365 day
TTL depending on churn rate).

## Idempotency

Each seeder builds a canonical-key index from the live entities first,
then per-row decides:

- **create** — no entity with that canonical key exists
- **update** — entity exists but `name` or `metadata` differ
- **skip** — entity exists and matches

Re-running converges; nothing is duplicated. The seeders never delete —
pruning entities the seed list omits is an explicit operator decision.

Canonical keys per type:

| Type           | Canonical key                                       |
| -------------- | --------------------------------------------------- |
| `country`      | `metadata.iso3`                                     |
| `region`       | `metadata.iso_3166_2` (e.g. `US-CA`)                |
| `city`         | `entity.slug` (`gn-<geonames_id>`)                  |
| `industry`     | `metadata.code` (NAICS)                             |
| `technology`   | `entity.slug` (lowercase, hyphenated form of name)  |
| `university`   | `entity.slug` (`<iso2>-<slug(name)>`)               |

The seeders that don't have a declared metadata key in the entity-type
YAML use the entity's top-level `slug` for canonical-key lookup so we
don't have to extend the schemas.

## Failure handling

Per-row API errors are logged and counted (`failed` in the seeder summary)
but never abort the run. Each seeder ends with a structured summary:

```
{ entityType: 'country', created: 250, updated: 0, skipped: 0, failed: 0, errors: [] }
```

If a whole seeder throws (e.g. the source CSV stops resolving), the
entrypoint logs `✘ <step>` and moves to the next one. Downstream seeders
that need the failed step's FKs will simply find fewer mappings and skip
the rows that don't resolve.

## Tests

Unit tests live under `__tests__/` and cover parsing + spec-construction
+ idempotent decision logic against bundled fixtures. They never hit the
network or a live DB.

```bash
bun test scripts/seed-atlas/__tests__
```
