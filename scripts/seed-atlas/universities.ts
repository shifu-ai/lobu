/**
 * scripts/seed-atlas/universities.ts
 *
 * Seeds atlas.university.
 *
 * Primary source (intended): WHED — World Higher Education Database
 * (https://www.whed.net). WHED publishes a comprehensive top-~5k list but
 * its API requires either a license or attribution + a registered token.
 *
 * Fallback source (used here, no auth required):
 *   https://github.com/Hipo/university-domains-list
 *   https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json
 *
 * That dataset is community-maintained, ~10k entries with `name`, `country`
 * (full English name, not ISO-2), `alpha_two_code` (ISO-2), and one or
 * more `web_pages` URLs. It does not provide founded_year or city, so
 * those fields are left empty (both are optional in university.yaml).
 *
 * Canonical key: derived URL-safe slug `<iso2>-<slug(name)>`. Stable as
 * long as the canonical English name is stable.
 *
 * Cross-entity FK: country_id resolved by ISO-2 (alpha_two_code).
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

const SOURCE_URL =
  "https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json";

interface HipoUniversity {
  name: string;
  country: string;
  alpha_two_code: string;
  "state-province"?: string | null;
  web_pages?: string[];
  domains?: string[];
}

async function fetchUniversities(): Promise<HipoUniversity[]> {
  const cached = cachePath("hipo-universities.json");
  if (isFreshCache(cached, 30)) {
    return JSON.parse(readFileSync(cached, "utf8")) as HipoUniversity[];
  }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`
    );
  }
  const text = await res.text();
  writeFileSync(cached, text);
  return JSON.parse(text) as HipoUniversity[];
}

export interface UniversityRow {
  name: string;
  countryIso2: string;
  homepage_url?: string;
}

export function buildUniversityRows(source: HipoUniversity[]): UniversityRow[] {
  const out: UniversityRow[] = [];
  for (const u of source) {
    if (!u.name || !u.alpha_two_code) continue;
    const countryIso2 = u.alpha_two_code.toUpperCase();
    if (countryIso2.length !== 2) continue;
    out.push({
      name: u.name,
      countryIso2,
      homepage_url: u.web_pages?.[0],
    });
  }
  return out;
}

export function slugifyUniversity(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildUniversitySpec(
  row: UniversityRow,
  countryIdByIso2: ReadonlyMap<string, number>
): UpsertSpec | null {
  const country_id = countryIdByIso2.get(row.countryIso2);
  if (country_id === undefined) return null;
  const slug = `${row.countryIso2.toLowerCase()}-${slugifyUniversity(row.name)}`;
  const metadata: Record<string, unknown> = {
    country_id,
  };
  if (row.homepage_url) metadata.homepage_url = row.homepage_url;
  return {
    entityType: "university",
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

export async function seedUniversities(ctx: SeederContext): Promise<void> {
  const log = makeLogger("universities");
  const schema = loadAtlasEntityType("university");

  let countryIdByIso2: Map<string, number>;
  if (ctx.client) {
    countryIdByIso2 = await buildCountryIdByIso2(ctx.client);
    log(`resolved country_id for ${countryIdByIso2.size} ISO-2 codes`);
  } else {
    countryIdByIso2 = new Map([
      ["US", 1],
      ["GB", 2],
      ["DE", 3],
      ["FR", 4],
      ["JP", 5],
      ["CA", 6],
    ]);
    log("[dry-run] using synthetic country_id map");
  }

  const source = await fetchUniversities();
  const rows = buildUniversityRows(source);
  log(`built ${rows.length} university rows from Hipo source`);

  const specs: UpsertSpec[] = [];
  let dropped = 0;
  for (const row of rows) {
    const spec = buildUniversitySpec(row, countryIdByIso2);
    if (spec) specs.push(spec);
    else dropped++;
  }
  if (dropped > 0)
    log(`dropped ${dropped} universities with no resolvable country_id`);

  if (specs.length > 0) {
    const errs = validateMetadataAgainstSchema(
      schema,
      (specs[0] as UpsertSpec).metadata
    );
    if (errs.length > 0) {
      throw new Error(
        `university payload mismatches university.yaml: ${errs.join("; ")}`
      );
    }
  }

  const summary = await upsertEntities(ctx, "university", specs, "slug");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedUniversities({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("universities"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
