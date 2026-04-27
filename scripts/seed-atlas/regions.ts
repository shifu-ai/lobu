/**
 * scripts/seed-atlas/regions.ts
 *
 * Seeds atlas.region (ISO 3166-2 first administrative level) for the top-50
 * countries by population. Source:
 *   https://github.com/olahol/iso-3166-2.json
 *
 * That repo publishes a single JSON file at the repo root, shaped:
 *   { "<ISO2>": { name: "Country", divisions: { "<ISO 3166-2>": "Region" } } }
 *
 * We download once, filter to top-50 by population, and emit one spec per
 * division — ~2k regions total.
 *
 * Canonical key: metadata.iso_3166_2 (e.g. "US-CA"). Always present.
 *
 * Cross-entity FK: region.country_id is resolved by listing atlas.country
 * once at the start of the run and building an iso2→entity_id map.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  type AtlasClient,
  cachePath,
  createHttpAtlasClient,
  isFreshCache,
  loadAtlasEntityType,
  makeLogger,
  parseRootArgs,
  type SeederContext,
  type UpsertSpec,
  upsertEntities,
  validateMetadataAgainstSchema,
} from "./lib.ts";

// Top-50 countries by 2024 UN population estimate (rough cut, stable enough
// for a seed list — when the source dataset adds more files we can extend).
export const TOP_50_ISO2: readonly string[] = Object.freeze([
  "IN",
  "CN",
  "US",
  "ID",
  "PK",
  "NG",
  "BR",
  "BD",
  "RU",
  "MX",
  "ET",
  "JP",
  "EG",
  "PH",
  "VN",
  "CD",
  "IR",
  "TR",
  "DE",
  "TH",
  "GB",
  "FR",
  "IT",
  "ZA",
  "TZ",
  "MM",
  "KE",
  "KR",
  "CO",
  "ES",
  "UG",
  "AR",
  "DZ",
  "SD",
  "UA",
  "IQ",
  "AF",
  "PL",
  "CA",
  "MA",
  "SA",
  "UZ",
  "PE",
  "AO",
  "MY",
  "MZ",
  "GH",
  "YE",
  "NP",
  "VE",
]);

export interface RegionSourceCountry {
  name: string;
  divisions: Record<string, string>;
}

export type RegionSourceFile = Record<string, RegionSourceCountry>;

const SOURCE_URL =
  "https://raw.githubusercontent.com/olahol/iso-3166-2.json/master/iso-3166-2.json";

async function fetchAllRegions(): Promise<RegionSourceFile> {
  const cached = cachePath("iso-3166-2.json");
  if (isFreshCache(cached, 30)) {
    return JSON.parse(readFileSync(cached, "utf8")) as RegionSourceFile;
  }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`
    );
  }
  const text = await res.text();
  writeFileSync(cached, text);
  return JSON.parse(text) as RegionSourceFile;
}

export interface RegionRow {
  iso_3166_2: string; // e.g. "US-CA"
  countryIso2: string; // e.g. "US"
  name: string;
}

export function buildRegionRows(
  countryIso2: string,
  source: RegionSourceCountry | undefined
): RegionRow[] {
  if (!source) return [];
  return Object.entries(source.divisions ?? {})
    .filter(
      ([code, name]) => code.startsWith(`${countryIso2}-`) && Boolean(name)
    )
    .map(([code, name]) => ({
      iso_3166_2: code,
      countryIso2,
      name,
    }));
}

export function buildRegionSpec(
  row: RegionRow,
  countryIdByIso2: ReadonlyMap<string, number>
): UpsertSpec {
  const country_id = countryIdByIso2.get(row.countryIso2);
  if (country_id === undefined) {
    throw new Error(
      `region ${row.iso_3166_2}: no atlas.country found for iso2 ${row.countryIso2}`
    );
  }
  return {
    entityType: "region",
    name: row.name,
    slug: row.iso_3166_2.toLowerCase(),
    canonicalKey: row.iso_3166_2,
    canonicalKeyField: "iso_3166_2",
    metadata: {
      country_id,
      iso_3166_2: row.iso_3166_2,
    },
  };
}

/** Build an iso2→country_id map from a live atlas.country listing. */
export async function buildCountryIdByIso2(
  client: AtlasClient
): Promise<Map<string, number>> {
  const countries = await client.list("country");
  const out = new Map<string, number>();
  for (const c of countries) {
    const iso2 = (c.metadata?.iso2 ?? "") as string;
    if (iso2) out.set(iso2.toUpperCase(), c.id);
  }
  return out;
}

export async function seedRegions(ctx: SeederContext): Promise<void> {
  const log = makeLogger("regions");
  const schema = loadAtlasEntityType("region");

  // FK resolution. Dry-run uses a synthetic placeholder map so we can still
  // print payloads without a live API.
  let countryIdByIso2: Map<string, number>;
  if (ctx.client) {
    countryIdByIso2 = await buildCountryIdByIso2(ctx.client);
    log(`resolved country_id for ${countryIdByIso2.size} ISO-2 codes`);
  } else {
    countryIdByIso2 = new Map(TOP_50_ISO2.map((iso2, i) => [iso2, i + 1]));
    log(
      `[dry-run] using synthetic country_id map (${countryIdByIso2.size} entries)`
    );
  }

  const allRegions = await fetchAllRegions();
  const allSpecs: UpsertSpec[] = [];
  for (const iso2 of TOP_50_ISO2) {
    const rows = buildRegionRows(iso2, allRegions[iso2]);
    for (const row of rows) {
      try {
        allSpecs.push(buildRegionSpec(row, countryIdByIso2));
      } catch (err) {
        log(`skip ${row.iso_3166_2}: ${(err as Error).message}`);
      }
    }
  }
  log(
    `built ${allSpecs.length} region specs across ${TOP_50_ISO2.length} countries`
  );

  // Validate one payload against region.yaml so schema drift fails fast.
  if (allSpecs.length > 0) {
    const errs = validateMetadataAgainstSchema(
      schema,
      (allSpecs[0] as UpsertSpec).metadata
    );
    if (errs.length > 0) {
      throw new Error(
        `region payload mismatches region.yaml: ${errs.join("; ")}`
      );
    }
  }

  const summary = await upsertEntities(ctx, "region", allSpecs, "iso_3166_2");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedRegions({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("regions"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
