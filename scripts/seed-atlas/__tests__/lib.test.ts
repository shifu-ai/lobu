import { describe, expect, test } from "bun:test";
import {
  type AtlasClient,
  type AtlasCreateInput,
  type AtlasUpdateInput,
  indexByCanonicalKey,
  loadAtlasEntityType,
  needsUpdate,
  parseRootArgs,
  type UpsertSpec,
  upsertEntities,
  validateMetadataAgainstSchema,
} from "../lib.ts";

describe("parseRootArgs", () => {
  test("parses --dry-run / --only / --limit", () => {
    expect(
      parseRootArgs(["--dry-run", "--only=countries,cities", "--limit=5"])
    ).toEqual({
      dryRun: true,
      only: new Set(["countries", "cities"]),
      limit: 5,
    });
  });

  test("defaults sane", () => {
    expect(parseRootArgs([])).toEqual({ dryRun: false, only: null });
  });
});

describe("indexByCanonicalKey", () => {
  test("keys by metadata field; ignores rows missing the key", () => {
    const map = indexByCanonicalKey(
      [
        { id: 1, name: "United States", metadata: { iso3: "USA" } },
        { id: 2, name: "United Kingdom", metadata: { iso3: "GBR" } },
        { id: 3, name: "Mystery", metadata: {} },
      ],
      "iso3"
    );
    expect(map.size).toBe(2);
    expect(map.get("USA")?.id).toBe(1);
    expect(map.get("GBR")?.id).toBe(2);
  });

  test("supports the slug top-level field", () => {
    const map = indexByCanonicalKey(
      [
        { id: 1, name: "PostgreSQL", slug: "postgresql" },
        { id: 2, name: "Redis", slug: "redis" },
        { id: 3, name: "No slug here" },
      ],
      "slug"
    );
    expect(map.size).toBe(2);
    expect(map.get("postgresql")?.id).toBe(1);
  });

  test("supports the explicit metadata.<field> form", () => {
    const map = indexByCanonicalKey(
      [{ id: 1, name: "X", metadata: { code: "541512" } }],
      "metadata.code"
    );
    expect(map.get("541512")?.id).toBe(1);
  });
});

describe("needsUpdate", () => {
  const proposed: UpsertSpec = {
    entityType: "country",
    canonicalKey: "USA",
    canonicalKeyField: "iso3",
    name: "United States",
    metadata: { iso2: "US", iso3: "USA", region: "Americas" },
  };

  test("returns false when name and metadata match", () => {
    expect(
      needsUpdate(
        {
          id: 1,
          name: "United States",
          metadata: { iso2: "US", iso3: "USA", region: "Americas" },
        },
        proposed
      )
    ).toBe(false);
  });

  test("returns true on name drift", () => {
    expect(
      needsUpdate(
        {
          id: 1,
          name: "USA",
          metadata: { iso2: "US", iso3: "USA", region: "Americas" },
        },
        proposed
      )
    ).toBe(true);
  });

  test("returns true on metadata drift", () => {
    expect(
      needsUpdate(
        {
          id: 1,
          name: "United States",
          metadata: { iso2: "US", iso3: "USA", region: "NorthAmerica" },
        },
        proposed
      )
    ).toBe(true);
  });

  test("returns true on missing metadata key", () => {
    expect(
      needsUpdate(
        { id: 1, name: "United States", metadata: { iso2: "US", iso3: "USA" } },
        proposed
      )
    ).toBe(true);
  });
});

// ── Mock AtlasClient for upsert end-to-end ─────────────────────────────

interface MockState {
  next: number;
  rows: Map<
    number,
    { id: number; name: string; metadata: Record<string, unknown> }
  >;
  creates: AtlasCreateInput[];
  updates: AtlasUpdateInput[];
}

function makeMockClient(
  initial: Array<{
    id: number;
    name: string;
    metadata: Record<string, unknown>;
  }>
): {
  client: AtlasClient;
  state: MockState;
} {
  const state: MockState = {
    next: Math.max(0, ...initial.map((r) => r.id)) + 1,
    rows: new Map(initial.map((r) => [r.id, r])),
    creates: [],
    updates: [],
  };
  const client: AtlasClient = {
    async list() {
      return [...state.rows.values()];
    },
    async create(input) {
      state.creates.push(input);
      const row = {
        id: state.next++,
        name: input.name,
        metadata: input.metadata ?? {},
      };
      state.rows.set(row.id, row);
      return row;
    },
    async update(input) {
      state.updates.push(input);
      const row = state.rows.get(input.entity_id);
      if (!row) throw new Error(`unknown entity ${input.entity_id}`);
      if (input.name) row.name = input.name;
      if (input.metadata) row.metadata = input.metadata;
      return row;
    },
  };
  return { client, state };
}

/** Silent log sink — discards args without producing test output. */
const silentLog = (..._args: unknown[]): void => undefined;

describe("upsertEntities", () => {
  const specs: UpsertSpec[] = [
    {
      entityType: "country",
      canonicalKey: "USA",
      canonicalKeyField: "iso3",
      name: "United States",
      metadata: { iso2: "US", iso3: "USA", region: "Americas" },
    },
    {
      entityType: "country",
      canonicalKey: "GBR",
      canonicalKeyField: "iso3",
      name: "United Kingdom",
      metadata: { iso2: "GB", iso3: "GBR", region: "Europe" },
    },
  ];

  test("first run: creates everything", async () => {
    const { client, state } = makeMockClient([]);
    const summary = await upsertEntities(
      {
        client,
        options: { dryRun: false, rateLimitPerSec: 1000 },
        log: silentLog,
      },
      "country",
      specs,
      "iso3"
    );
    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(state.creates).toHaveLength(2);
  });

  test("second run with no drift: skips everything", async () => {
    const { client, state } = makeMockClient([
      {
        id: 1,
        name: "United States",
        metadata: { iso2: "US", iso3: "USA", region: "Americas" },
      },
      {
        id: 2,
        name: "United Kingdom",
        metadata: { iso2: "GB", iso3: "GBR", region: "Europe" },
      },
    ]);
    const summary = await upsertEntities(
      {
        client,
        options: { dryRun: false, rateLimitPerSec: 1000 },
        log: silentLog,
      },
      "country",
      specs,
      "iso3"
    );
    expect(summary).toMatchObject({
      created: 0,
      updated: 0,
      skipped: 2,
      failed: 0,
    });
    expect(state.creates).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  test("drifted row gets updated", async () => {
    const { client, state } = makeMockClient([
      {
        id: 1,
        name: "USA",
        metadata: { iso2: "US", iso3: "USA", region: "Americas" },
      },
      {
        id: 2,
        name: "United Kingdom",
        metadata: { iso2: "GB", iso3: "GBR", region: "Europe" },
      },
    ]);
    const summary = await upsertEntities(
      {
        client,
        options: { dryRun: false, rateLimitPerSec: 1000 },
        log: silentLog,
      },
      "country",
      specs,
      "iso3"
    );
    expect(summary).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.entity_id).toBe(1);
  });

  test("failed creates are caught + reported, run continues", async () => {
    const flaky: AtlasClient = {
      async list() {
        return [];
      },
      async create(input) {
        if (input.name === "United States") throw new Error("boom");
        return { id: 1, name: input.name };
      },
      async update() {
        throw new Error("not used");
      },
    };
    const summary = await upsertEntities(
      {
        client: flaky,
        options: { dryRun: false, rateLimitPerSec: 1000 },
        log: silentLog,
      },
      "country",
      specs,
      "iso3"
    );
    expect(summary.created).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.errors[0]).toMatchObject({ key: "USA", message: "boom" });
  });

  test("dry-run logs and short-circuits — no client calls", async () => {
    const summary = await upsertEntities(
      { client: null, options: { dryRun: true }, log: silentLog },
      "country",
      specs,
      "iso3"
    );
    expect(summary.created).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.failed).toBe(0);
  });

  test("--limit caps the rows processed", async () => {
    const { client, state } = makeMockClient([]);
    const summary = await upsertEntities(
      {
        client,
        options: { dryRun: false, rateLimitPerSec: 1000, limit: 1 },
        log: silentLog,
      },
      "country",
      specs,
      "iso3"
    );
    expect(summary.created).toBe(1);
    expect(state.creates).toHaveLength(1);
  });
});

describe("schema validation", () => {
  test("country payload validates against country.yaml", () => {
    const schema = loadAtlasEntityType("country");
    expect(
      validateMetadataAgainstSchema(schema, {
        iso2: "US",
        iso3: "USA",
        region: "Americas",
        currency: "USD",
        population: 333_000_000,
      })
    ).toEqual([]);
  });

  test("flags unknown metadata keys", () => {
    const schema = loadAtlasEntityType("country");
    const errs = validateMetadataAgainstSchema(schema, {
      iso2: "US",
      iso3: "USA",
      bogus: "value",
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join("\n")).toContain("bogus");
  });

  test("flags type mismatches", () => {
    const schema = loadAtlasEntityType("city");
    const errs = validateMetadataAgainstSchema(schema, {
      country_id: "not-a-number",
      latitude: 0,
      longitude: 0,
      population: 100_000,
    });
    expect(errs.join("\n")).toContain("country_id");
  });

  test("industry enum is enforced", () => {
    const schema = loadAtlasEntityType("industry");
    const ok = validateMetadataAgainstSchema(schema, {
      taxonomy_source: "NAICS",
      code: "541512",
    });
    expect(ok).toEqual([]);
    const bad = validateMetadataAgainstSchema(schema, {
      taxonomy_source: "WRONG",
      code: "541512",
    });
    expect(bad.join("\n")).toContain("taxonomy_source");
  });
});
