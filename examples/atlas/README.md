# Atlas — public reference catalog

Atlas is a public, slow-churn reference catalog. It owns the world-knowledge
layer that every other public catalog needs to compose against:

- **Places**: country, region, city
- **Taxonomies**: industry, technology
- **Institutions**: university

Atlas sits next to other public catalogs (e.g. `market`) as a sibling org.
Catalogs reference Atlas via cross-org relationships (e.g.
`market.company` `headquartered_in` `atlas.city`), so canonical place +
taxonomy data lives once, in Atlas, and is reused everywhere instead of
being duplicated per catalog.

## Why this is its own org

- **Visibility / lifecycle differ.** Atlas churns slowly (countries don't
  appear weekly), so it can be auto-seeded from public datasets and held
  to a stricter evidence bar than active business graphs like `market`.
- **Composition.** Adding a third public catalog later (real estate,
  research, …) reuses Atlas with no migration — same shape as Market
  referencing Atlas today.
- **No identity-claim surface.** Identity claims don't apply to Atlas
  (no one owns a city), so the contribution model here is purely
  admin-curated. Other catalogs (e.g. `market`) handle identity through
  the connector-facts engine; Atlas opts out.

## Entity types (Phase 1 — schema only)

| Slug         | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `country`    | Sovereign country (ISO 3166-1)                           |
| `region`     | First-level administrative region (state, province)      |
| `city`       | Populated place (city, town, metro)                      |
| `industry`   | Industry / sector taxonomy node (NAICS / BICS / custom)  |
| `technology` | Tool, framework, library, platform                       |
| `university` | Higher-education institution                             |

Schemas live in `models/`. Field definitions follow the same TypeBox-/
JSON-Schema-style shape as the other `examples/<org>/models/` catalogs.

## What ships in this PR

- The entity-type YAML in `models/`.
- `lobu.toml` declaring the `atlas` org name + a curator agent stub.
- The `scripts/migrate/create-atlas-org.sql` migration that inserts the
  `atlas` row (`visibility='public'`).

## What does **not** ship in this PR

- **Data seeding** (Phase 2). One-shot scripts under
  `scripts/seed-atlas/` will populate countries (ISO-3166), regions
  (ISO-3166-2 top admin level for top-50 countries), cities (GeoNames
  ≥ 50k pop), industries (NAICS 2022), technologies (curated seed),
  and universities (WHED top ~5k).
- **Cross-org relationship types** that target Atlas (`headquartered_in`,
  `operates_in`, `educated_at`, `uses_technology`, `in_industry`). Those
  are registered on the **source-side org** (`market`), not on Atlas, and
  ship in this PR alongside the rest of the Market schema extension.
- **Contribution flow.** Atlas is admin-curated for v1 — there is no
  contributor-driven proposal flow. When a connector-facts engine
  follow-up adds public-catalog claims, Atlas opts out: no
  identity-style relationships exist on these entity types.
