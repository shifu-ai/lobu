import { describe, expect, test } from "bun:test";
import { buildCitySpec, parseCitiesFile, parseGeonamesRow } from "../cities.ts";

// 19-column GeoNames rows in tab-separated format. Column meanings are
// documented in cities.ts.
const ROW = [
  "5128581", // 1  geonameid
  "New York City", // 2  name
  "New York City", // 3  asciiname
  "NYC,Big Apple", // 4  alternatenames
  "40.71427", // 5  latitude
  "-74.00597", // 6  longitude
  "P", // 7  feature class
  "PPL", // 8  feature code
  "US", // 9  country code
  "", // 10 cc2
  "NY", // 11 admin1
  "061", // 12 admin2
  "", // 13 admin3
  "", // 14 admin4
  "8175133", // 15 population
  "57", // 16 elevation
  "10", // 17 dem
  "America/New_York", // 18 timezone
  "2024-01-01", // 19 modification date
].join("\t");

const SMALL_ROW = ROW.replace("8175133", "1000"); // below 50k floor

const FIXTURE_FILE = [
  ROW,
  SMALL_ROW,
  // Berlin
  [
    "2950159",
    "Berlin",
    "Berlin",
    "",
    "52.52437",
    "13.41053",
    "P",
    "PPL",
    "DE",
    "",
    "16",
    "",
    "",
    "",
    "3426354",
    "34",
    "43",
    "Europe/Berlin",
    "2024-01-01",
  ].join("\t"),
  // Tokyo
  [
    "1850147",
    "Tokyo",
    "Tokyo",
    "",
    "35.6895",
    "139.69171",
    "P",
    "PPL",
    "JP",
    "",
    "13",
    "",
    "",
    "",
    "8336599",
    "17",
    "40",
    "Asia/Tokyo",
    "2024-01-01",
  ].join("\t"),
  // City with no admin1 (still valid; region_id stays unset)
  [
    "100",
    "MysteryTown",
    "Mystery",
    "",
    "0",
    "0",
    "P",
    "PPL",
    "XX",
    "",
    "",
    "",
    "",
    "",
    "60000",
    "0",
    "0",
    "UTC",
    "2024-01-01",
  ].join("\t"),
].join("\n");

describe("parseGeonamesRow", () => {
  test("returns a CityRow for valid >50k rows", () => {
    const row = parseGeonamesRow(ROW);
    expect(row).toMatchObject({
      geonames_id: 5128581,
      name: "New York City",
      countryIso2: "US",
      admin1: "NY",
      latitude: 40.71427,
      longitude: -74.00597,
      population: 8175133,
    });
  });

  test("drops rows under the population floor", () => {
    expect(parseGeonamesRow(SMALL_ROW)).toBeNull();
  });

  test("drops rows with too few columns", () => {
    expect(parseGeonamesRow("a\tb\tc")).toBeNull();
  });
});

describe("parseCitiesFile", () => {
  test("parses multi-line file, drops sub-floor rows", () => {
    const rows = parseCitiesFile(FIXTURE_FILE);
    expect(rows).toHaveLength(4); // NYC, Berlin, Tokyo, MysteryTown — small NYC clone dropped
    expect(rows.map((r) => r.name).sort()).toEqual([
      "Berlin",
      "MysteryTown",
      "New York City",
      "Tokyo",
    ]);
  });
});

describe("buildCitySpec", () => {
  const countryIdByIso2 = new Map([
    ["US", 1],
    ["DE", 2],
    ["JP", 3],
  ]);
  const regionIdByCode = new Map([
    ["US-NY", 100],
    ["DE-16", 200],
  ]);

  test("resolves both country_id and region_id when available", () => {
    const row = parseGeonamesRow(ROW);
    expect(row).toBeDefined();
    const spec = buildCitySpec(row!, countryIdByIso2, regionIdByCode);
    expect(spec).toMatchObject({
      entityType: "city",
      name: "New York City",
      slug: "gn-5128581",
      canonicalKey: "gn-5128581",
      canonicalKeyField: "slug",
      metadata: {
        country_id: 1,
        region_id: 100,
        latitude: 40.71427,
        longitude: -74.00597,
        population: 8175133,
      },
    });
    expect(
      (spec!.metadata as Record<string, unknown>).geonames_id
    ).toBeUndefined();
  });

  test("omits region_id when admin1 is unknown", () => {
    const rows = parseCitiesFile(FIXTURE_FILE);
    const tokyo = rows.find((r) => r.name === "Tokyo")!;
    const spec = buildCitySpec(tokyo, countryIdByIso2, regionIdByCode);
    expect(spec?.metadata.region_id).toBeUndefined();
    expect(spec?.metadata.country_id).toBe(3);
  });

  test("returns null when country FK does not resolve", () => {
    const rows = parseCitiesFile(FIXTURE_FILE);
    const mystery = rows.find((r) => r.name === "MysteryTown")!;
    expect(buildCitySpec(mystery, countryIdByIso2, regionIdByCode)).toBeNull();
  });
});
