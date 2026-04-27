import { describe, expect, test } from "bun:test";
import { buildCountryRows, buildCountrySpec } from "../countries.ts";

const FIXTURE = [
  {
    name: "United States of America",
    "alpha-2": "us",
    "alpha-3": "usa",
    region: "Americas",
  },
  {
    name: "United Kingdom of Great Britain and Northern Ireland",
    "alpha-2": "GB",
    "alpha-3": "GBR",
    region: "Europe",
  },
  { name: "Japan", "alpha-2": "JP", "alpha-3": "JPN", region: "Asia" },
  // Missing alpha-3 — must be filtered out.
  { name: "Bogus", "alpha-2": "XX", "alpha-3": "" },
  { name: "France", "alpha-2": "FR", "alpha-3": "FRA", region: "Europe" },
];

describe("buildCountryRows", () => {
  test("drops rows missing iso codes", () => {
    expect(buildCountryRows(FIXTURE)).toHaveLength(4);
  });

  test("uppercases iso2/iso3 and propagates region/currency", () => {
    const rows = buildCountryRows(FIXTURE);
    const usa = rows.find((r) => r.iso3 === "USA");
    expect(usa).toBeDefined();
    expect(usa).toMatchObject({
      iso2: "US",
      iso3: "USA",
      region: "Americas",
      currency: "USD",
    });
  });

  test("rows with no currency mapping get an empty string", () => {
    const rows = buildCountryRows([
      { name: "Tuvalu", "alpha-2": "TV", "alpha-3": "TUV", region: "Oceania" },
    ]);
    expect(rows[0]?.currency).toBe("");
  });
});

describe("buildCountrySpec", () => {
  test("emits the canonical key + slug + only declared metadata", () => {
    const spec = buildCountrySpec({
      iso2: "JP",
      iso3: "JPN",
      name: "Japan",
      region: "Asia",
      currency: "JPY",
    });
    expect(spec).toMatchObject({
      entityType: "country",
      name: "Japan",
      slug: "jpn",
      canonicalKey: "JPN",
      canonicalKeyField: "iso3",
      metadata: { iso2: "JP", iso3: "JPN", region: "Asia", currency: "JPY" },
    });
  });

  test("omits empty currency/region from metadata", () => {
    const spec = buildCountrySpec({
      iso2: "TV",
      iso3: "TUV",
      name: "Tuvalu",
      region: "",
      currency: "",
    });
    expect(spec.metadata).toEqual({ iso2: "TV", iso3: "TUV" });
  });
});
