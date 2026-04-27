import { describe, expect, test } from "bun:test";
import {
  buildUniversityRows,
  buildUniversitySpec,
  slugifyUniversity,
} from "../universities.ts";

const SOURCE = [
  {
    name: "Massachusetts Institute of Technology",
    country: "United States",
    alpha_two_code: "US",
    web_pages: ["https://web.mit.edu/"],
    domains: ["mit.edu"],
  },
  {
    name: "University of Cambridge",
    country: "United Kingdom",
    alpha_two_code: "GB",
    web_pages: ["https://www.cam.ac.uk/"],
    domains: ["cam.ac.uk"],
  },
  // Missing alpha_two_code — must be filtered.
  {
    name: "Bogus",
    country: "Nowhere",
    alpha_two_code: "",
    web_pages: [],
    domains: [],
  },
];

describe("slugifyUniversity", () => {
  test("lowercases, hyphenates, strips diacritics", () => {
    expect(slugifyUniversity("Universität Zürich")).toBe("universitat-zurich");
  });

  test("drops parenthesis-style punctuation", () => {
    expect(slugifyUniversity("University of California (Berkeley)")).toBe(
      "university-of-california-berkeley"
    );
  });
});

describe("buildUniversityRows", () => {
  test("drops rows with no ISO-2", () => {
    const rows = buildUniversityRows(SOURCE);
    expect(rows).toHaveLength(2);
  });

  test("uppercases alpha_two_code and grabs the first web page", () => {
    const rows = buildUniversityRows(SOURCE);
    const mit = rows[0]!;
    expect(mit).toMatchObject({
      name: "Massachusetts Institute of Technology",
      countryIso2: "US",
      homepage_url: "https://web.mit.edu/",
    });
  });
});

describe("buildUniversitySpec", () => {
  const countryIdByIso2 = new Map([
    ["US", 1],
    ["GB", 2],
  ]);

  test("emits canonical key with iso2 prefix and resolves country_id", () => {
    const spec = buildUniversitySpec(
      {
        name: "Massachusetts Institute of Technology",
        countryIso2: "US",
        homepage_url: "https://web.mit.edu/",
      },
      countryIdByIso2
    );
    expect(spec).toMatchObject({
      entityType: "university",
      name: "Massachusetts Institute of Technology",
      slug: "us-massachusetts-institute-of-technology",
      canonicalKey: "us-massachusetts-institute-of-technology",
      canonicalKeyField: "slug",
      metadata: {
        country_id: 1,
        homepage_url: "https://web.mit.edu/",
      },
    });
    expect((spec!.metadata as Record<string, unknown>).slug).toBeUndefined();
  });

  test("returns null when country_id cannot be resolved", () => {
    const spec = buildUniversitySpec(
      { name: "Phantom U", countryIso2: "XX" },
      countryIdByIso2
    );
    expect(spec).toBeNull();
  });

  test("omits homepage_url when missing", () => {
    const spec = buildUniversitySpec(
      { name: "Quiet College", countryIso2: "GB" },
      countryIdByIso2
    );
    expect(spec?.metadata.homepage_url).toBeUndefined();
  });
});
