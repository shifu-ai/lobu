/**
 * scripts/seed-atlas/cities.ts
 *
 * Seeds atlas.city from GeoNames cities1000.txt, filtered to population
 * ≥ 50_000 (~30k cities globally).
 *
 * Source:
 *   https://download.geonames.org/export/dump/cities1000.zip
 *
 * The unzipped file is a tab-separated text file with one row per city.
 * Column layout (1-indexed, per geonames.org/manual.html):
 *
 *   1  geonameid
 *   2  name (UTF-8)
 *   3  asciiname
 *   4  alternatenames (comma-separated)
 *   5  latitude
 *   6  longitude
 *   7  feature class
 *   8  feature code
 *   9  country code (ISO-2)
 *  10  cc2
 *  11  admin1 code (region; ISO 3166-2 suffix in many countries)
 *  12  admin2 code
 *  13  admin3 code
 *  14  admin4 code
 *  15  population
 *  16  elevation
 *  17  dem
 *  18  timezone
 *  19  modification date
 *
 * Canonical key: entity.slug (`gn-<geonames_id>`). The geonames_id is also
 * encoded in the slug, so the slug is stable across name changes and
 * obviously unique. We don't put it in metadata because city.yaml doesn't
 * declare a `geonames_id` field.
 *
 * Cross-entity FKs:
 *   - country_id  ← atlas.country, resolved by ISO-2 (column 9)
 *   - region_id   ← atlas.region, resolved by ISO-3166-2 (`<iso2>-<admin1>`)
 *     when both halves are known. Optional in the schema, so missing is OK.
 *
 * Cache: the zip is cached at ./data/cities1000.zip and unzipped to
 * ./data/cities1000.txt. Re-runs reuse both.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

const SOURCE_URL = "https://download.geonames.org/export/dump/cities1000.zip";
const POP_FLOOR = 50_000;

async function ensureCitiesFile(): Promise<string> {
  const txt = cachePath("cities1000.txt");
  if (isFreshCache(txt, 60)) return txt;
  const zip = cachePath("cities1000.zip");
  if (!isFreshCache(zip, 60)) {
    const res = await fetch(SOURCE_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`
      );
    }
    const buf = await res.arrayBuffer();
    writeFileSync(zip, Buffer.from(buf));
  }
  if (!existsSync(txt)) {
    // Shell out to unzip — universally available on dev machines, no extra deps.
    execFileSync("unzip", ["-o", zip, "-d", dirname(zip)], { stdio: "pipe" });
  }
  return txt;
}

export interface CityRow {
  geonames_id: number;
  name: string;
  countryIso2: string;
  admin1: string;
  latitude: number;
  longitude: number;
  population: number;
}

/**
 * Parse a single GeoNames row into a CityRow, or return null if it fails
 * the population floor or the layout is unexpected.
 */
export function parseGeonamesRow(
  line: string,
  popFloor = POP_FLOOR
): CityRow | null {
  const parts = line.split("\t");
  if (parts.length < 19) return null;
  const population = Number.parseInt(parts[14] ?? "", 10);
  if (!Number.isFinite(population) || population < popFloor) return null;
  const geonames_id = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isFinite(geonames_id)) return null;
  const name = parts[1];
  const countryIso2 = parts[8];
  if (!name || !countryIso2) return null;
  const latitude = Number.parseFloat(parts[4] ?? "");
  const longitude = Number.parseFloat(parts[5] ?? "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    geonames_id,
    name,
    countryIso2: countryIso2.toUpperCase(),
    admin1: (parts[10] ?? "").toUpperCase(),
    latitude,
    longitude,
    population,
  };
}

export function parseCitiesFile(
  content: string,
  popFloor = POP_FLOOR
): CityRow[] {
  const out: CityRow[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const row = parseGeonamesRow(line, popFloor);
    if (row) out.push(row);
  }
  return out;
}

export function buildCitySpec(
  row: CityRow,
  countryIdByIso2: ReadonlyMap<string, number>,
  regionIdByCode: ReadonlyMap<string, number>
): UpsertSpec | null {
  const country_id = countryIdByIso2.get(row.countryIso2);
  if (country_id === undefined) return null;
  const regionCode = row.admin1 ? `${row.countryIso2}-${row.admin1}` : "";
  const region_id = regionCode ? regionIdByCode.get(regionCode) : undefined;
  const metadata: Record<string, unknown> = {
    country_id,
    latitude: row.latitude,
    longitude: row.longitude,
    population: row.population,
  };
  if (region_id !== undefined) metadata.region_id = region_id;
  const slug = `gn-${row.geonames_id}`;
  return {
    entityType: "city",
    name: row.name,
    slug,
    canonicalKey: slug,
    canonicalKeyField: "slug",
    metadata,
  };
}

async function buildCountryIdByIso2(
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

async function buildRegionIdByCode(
  client: AtlasClient
): Promise<Map<string, number>> {
  const regions = await client.list("region");
  const out = new Map<string, number>();
  for (const r of regions) {
    const code = (r.metadata?.iso_3166_2 ?? "") as string;
    if (code) out.set(code.toUpperCase(), r.id);
  }
  return out;
}

export async function seedCities(ctx: SeederContext): Promise<void> {
  const log = makeLogger("cities");
  const schema = loadAtlasEntityType("city");

  let countryIdByIso2: Map<string, number>;
  let regionIdByCode: Map<string, number>;
  if (ctx.client) {
    countryIdByIso2 = await buildCountryIdByIso2(ctx.client);
    regionIdByCode = await buildRegionIdByCode(ctx.client);
    log(
      `resolved ${countryIdByIso2.size} country_id and ${regionIdByCode.size} region_id mappings`
    );
  } else {
    countryIdByIso2 = new Map([
      ["US", 1],
      ["GB", 2],
      ["DE", 3],
      ["FR", 4],
      ["JP", 5],
    ]);
    regionIdByCode = new Map([
      ["US-CA", 100],
      ["US-NY", 101],
    ]);
    log("[dry-run] using synthetic country_id/region_id maps");
  }

  const path = await ensureCitiesFile();
  const content = readFileSync(path, "utf8");
  const rows = parseCitiesFile(content);
  log(`parsed ${rows.length} cities with population ≥ ${POP_FLOOR}`);

  const specs: UpsertSpec[] = [];
  let dropped = 0;
  for (const row of rows) {
    const spec = buildCitySpec(row, countryIdByIso2, regionIdByCode);
    if (spec) specs.push(spec);
    else dropped++;
  }
  if (dropped > 0)
    log(`dropped ${dropped} cities with no resolvable country_id`);

  if (specs.length > 0) {
    const errs = validateMetadataAgainstSchema(
      schema,
      (specs[0] as UpsertSpec).metadata
    );
    if (errs.length > 0) {
      throw new Error(`city payload mismatches city.yaml: ${errs.join("; ")}`);
    }
  }

  const summary = await upsertEntities(ctx, "city", specs, "slug");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedCities({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("cities"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
