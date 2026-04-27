/**
 * scripts/seed-atlas/countries.ts
 *
 * Seeds atlas.country from the ISO-3166 dataset published by lukes/lukes:
 *   https://github.com/lukes/ISO-3166-Countries-with-Regional-Codes
 *
 * The "all" file is a single JSON array of ~250 entries with everything
 * we need (iso2, iso3, English short name, UN region). We supplement with
 * a tiny inline currency map for the largest ~70 economies; the rest get
 * an empty `currency` (declared optional in country.yaml).
 *
 * Canonical key: metadata.iso3 (always 3 letters, always present in source).
 *
 * Idempotency:
 *   - Re-running upserts in place. The seeder maintains a name→id map in
 *     ./data/country-id-map.json so cities/regions/universities can resolve
 *     country_id without re-listing every run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
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
  "https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.json";

interface IsoCountry {
  name: string;
  "alpha-2": string;
  "alpha-3": string;
  region?: string; // UN macro region
}

// ISO 4217 codes for the world's largest economies (rough cut). Anything not
// in this map gets an empty `currency` and that's fine — the field is optional.
const CURRENCY_BY_ISO3: Readonly<Record<string, string>> = Object.freeze({
  USA: "USD",
  GBR: "GBP",
  JPN: "JPY",
  CHN: "CNY",
  DEU: "EUR",
  FRA: "EUR",
  ITA: "EUR",
  ESP: "EUR",
  NLD: "EUR",
  BEL: "EUR",
  PRT: "EUR",
  GRC: "EUR",
  IRL: "EUR",
  AUT: "EUR",
  FIN: "EUR",
  LUX: "EUR",
  CHE: "CHF",
  SWE: "SEK",
  NOR: "NOK",
  DNK: "DKK",
  ISL: "ISK",
  POL: "PLN",
  CZE: "CZK",
  HUN: "HUF",
  ROU: "RON",
  BGR: "BGN",
  HRV: "EUR",
  RUS: "RUB",
  UKR: "UAH",
  TUR: "TRY",
  CAN: "CAD",
  MEX: "MXN",
  BRA: "BRL",
  ARG: "ARS",
  CHL: "CLP",
  COL: "COP",
  PER: "PEN",
  URY: "UYU",
  VEN: "VES",
  AUS: "AUD",
  NZL: "NZD",
  IND: "INR",
  IDN: "IDR",
  THA: "THB",
  VNM: "VND",
  MYS: "MYR",
  SGP: "SGD",
  PHL: "PHP",
  KOR: "KRW",
  PRK: "KPW",
  TWN: "TWD",
  HKG: "HKD",
  PAK: "PKR",
  BGD: "BDT",
  LKA: "LKR",
  NPL: "NPR",
  AFG: "AFN",
  IRN: "IRR",
  IRQ: "IQD",
  SAU: "SAR",
  ARE: "AED",
  QAT: "QAR",
  KWT: "KWD",
  BHR: "BHD",
  OMN: "OMR",
  JOR: "JOD",
  LBN: "LBP",
  SYR: "SYP",
  ISR: "ILS",
  EGY: "EGP",
  ZAF: "ZAR",
  NGA: "NGN",
  KEN: "KES",
  ETH: "ETB",
  MAR: "MAD",
  DZA: "DZD",
  TUN: "TND",
});

async function fetchCountries(): Promise<IsoCountry[]> {
  const cached = cachePath("iso-3166-all.json");
  if (isFreshCache(cached, 30)) {
    return JSON.parse(readFileSync(cached, "utf8")) as IsoCountry[];
  }
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`
    );
  }
  const text = await res.text();
  writeFileSync(cached, text);
  return JSON.parse(text) as IsoCountry[];
}

export interface CountryRow {
  iso2: string;
  iso3: string;
  name: string;
  region: string;
  currency: string;
}

export function buildCountryRows(source: IsoCountry[]): CountryRow[] {
  return source
    .filter((c) => c["alpha-3"] && c["alpha-2"] && c.name)
    .map((c) => {
      const iso3 = c["alpha-3"];
      return {
        iso2: c["alpha-2"].toUpperCase(),
        iso3: iso3.toUpperCase(),
        name: c.name,
        region: c.region ?? "",
        currency: CURRENCY_BY_ISO3[iso3.toUpperCase()] ?? "",
      };
    });
}

export function buildCountrySpec(row: CountryRow): UpsertSpec {
  const metadata: Record<string, unknown> = {
    iso2: row.iso2,
    iso3: row.iso3,
  };
  if (row.region) metadata.region = row.region;
  if (row.currency) metadata.currency = row.currency;
  return {
    entityType: "country",
    name: row.name,
    slug: row.iso3.toLowerCase(),
    canonicalKey: row.iso3,
    canonicalKeyField: "iso3",
    metadata,
  };
}

export async function seedCountries(ctx: SeederContext): Promise<void> {
  const log = makeLogger("countries");
  log("fetching ISO-3166 source list");
  const source = await fetchCountries();
  const rows = buildCountryRows(source);
  log(`built ${rows.length} country rows`);

  // Validate the first proposed row against the YAML schema once so we
  // fail loud on schema drift before hammering the API.
  const schema = loadAtlasEntityType("country");
  const sample = buildCountrySpec(rows[0] as CountryRow);
  const errs = validateMetadataAgainstSchema(schema, sample.metadata);
  if (errs.length > 0) {
    throw new Error(
      `country payload mismatches country.yaml: ${errs.join("; ")}`
    );
  }

  const specs = rows.map(buildCountrySpec);
  const summary = await upsertEntities(ctx, "country", specs, "iso3");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedCountries({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("countries"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
