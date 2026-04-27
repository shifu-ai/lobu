import { describe, expect, test } from "bun:test";
import { buildRegionRows, buildRegionSpec } from "../regions.ts";

const US_SOURCE = {
  name: "United States",
  divisions: {
    "US-CA": "California",
    "US-NY": "New York",
    // Cross-country garbage row mixed in — must be filtered out.
    "GB-LND": "London",
    // Empty name — must be filtered out.
    "US-XX": "",
  },
};

describe("buildRegionRows", () => {
  test("keeps only rows whose code prefixes match the country and have a name", () => {
    const rows = buildRegionRows("US", US_SOURCE);
    expect(rows.map((r) => r.iso_3166_2)).toEqual(["US-CA", "US-NY"]);
  });

  test("returns empty array when source is missing", () => {
    expect(buildRegionRows("XX", undefined)).toEqual([]);
  });
});

describe("buildRegionSpec", () => {
  const countryIdByIso2 = new Map([["US", 42]]);

  test("resolves country_id and emits canonical key", () => {
    const spec = buildRegionSpec(
      { iso_3166_2: "US-CA", countryIso2: "US", name: "California" },
      countryIdByIso2
    );
    expect(spec).toMatchObject({
      entityType: "region",
      name: "California",
      slug: "us-ca",
      canonicalKey: "US-CA",
      canonicalKeyField: "iso_3166_2",
      metadata: { country_id: 42, iso_3166_2: "US-CA" },
    });
  });

  test("throws when the country is not in the FK map", () => {
    expect(() =>
      buildRegionSpec(
        { iso_3166_2: "XX-YY", countryIso2: "XX", name: "Nowhere" },
        countryIdByIso2
      )
    ).toThrow();
  });
});
