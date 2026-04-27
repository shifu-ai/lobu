/**
 * scripts/seed-atlas/lib.ts
 *
 * Shared infrastructure for the Atlas seeders. Atlas is the public reference
 * catalog (countries, regions, cities, industries, technologies, universities)
 * defined in examples/atlas/. These helpers talk to the live Owletto backend
 * via the REST tool-proxy endpoint:
 *
 *   POST {OWLETTO_BASE_URL}/api/atlas/manage_entity
 *
 * with `Authorization: Bearer ${OWLETTO_API_TOKEN}`. The body is the same
 * action-discriminated payload the in-process MCP tool accepts.
 *
 * Idempotency model
 * -----------------
 * Each seeded entity carries a stable canonical key in its metadata
 * (e.g. country.iso3, city.geonames_id). On every run we list existing
 * entities of the type, build an in-memory key→id map, and decide whether
 * to create, update (if metadata or name changed), or skip.
 *
 * The runner does NOT delete entities the seed list omits. Pruning is a
 * separate operator decision.
 */

import yaml from "yaml";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Module path helpers ─────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root (resolved from this file's location: lobu/scripts/seed-atlas/lib.ts). */
export const REPO_ROOT = resolve(__dirname, "..", "..");

/** Local cache for downloaded raw datasets. Re-runs reuse what's there. */
export const CACHE_DIR = join(__dirname, "data");

// ── Types ───────────────────────────────────────────────────────────────

export interface AtlasClient {
  /** List entities of `entity_type`, paginated. Returns the flat array. */
  list(entity_type: string): Promise<AtlasEntity[]>;
  create(input: AtlasCreateInput): Promise<AtlasEntity>;
  update(input: AtlasUpdateInput): Promise<AtlasEntity>;
}

export interface AtlasEntity {
  id: number;
  name: string;
  slug?: string;
  entity_type?: string;
  metadata?: Record<string, unknown>;
}

export interface AtlasCreateInput {
  entity_type: string;
  name: string;
  slug?: string;
  parent_id?: number;
  metadata?: Record<string, unknown>;
}

export interface AtlasUpdateInput {
  entity_id: number;
  name?: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface SeederOptions {
  /** When true, log proposed payloads but make no API calls. */
  dryRun: boolean;
  /** Cap entities processed (after dedup). Useful for smoke-runs. */
  limit?: number;
  /** Soft ceiling on requests/sec; defaults to 50 (configurable via env). */
  rateLimitPerSec?: number;
}

export interface SeedSummary {
  entityType: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ key: string; message: string }>;
}

// ── HTTP-backed AtlasClient ─────────────────────────────────────────────

interface ToolError {
  error?: string;
}

/**
 * Builds an AtlasClient that talks to a live Owletto backend.
 *
 * Required env:
 *   OWLETTO_BASE_URL    e.g. https://owletto.example.com
 *   OWLETTO_API_TOKEN   PAT or OAuth bearer token with write access to atlas
 */
export function createHttpAtlasClient(opts?: {
  baseUrl?: string;
  token?: string;
  orgSlug?: string;
}): AtlasClient {
  const baseUrl = (opts?.baseUrl ?? process.env.OWLETTO_BASE_URL ?? "").replace(
    /\/+$/,
    ""
  );
  const token = opts?.token ?? process.env.OWLETTO_API_TOKEN ?? "";
  const orgSlug = opts?.orgSlug ?? "atlas";

  if (!baseUrl) {
    throw new Error(
      "OWLETTO_BASE_URL is required (e.g. https://owletto.example.com)"
    );
  }
  if (!token) {
    throw new Error(
      "OWLETTO_API_TOKEN is required (PAT or OAuth bearer token)"
    );
  }

  async function callTool<T>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const url = `${baseUrl}/api/${orgSlug}/${toolName}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as ToolError;
        detail = body.error ?? "";
      } catch {
        detail = await res.text();
      }
      throw new Error(
        `POST ${url} → ${res.status}${detail ? `: ${detail}` : ""}`
      );
    }
    return (await res.json()) as T;
  }

  return {
    async list(entity_type) {
      const all: AtlasEntity[] = [];
      const PAGE = 200;
      let offset = 0;
      // Defensive cap: 100k entities per type is well above any Atlas seed.
      const MAX = 100_000;
      while (offset < MAX) {
        const res = (await callTool<{ entities?: AtlasEntity[] }>(
          "manage_entity",
          {
            action: "list",
            entity_type,
            limit: PAGE,
            offset,
          }
        )) ?? { entities: [] };
        const page = res.entities ?? [];
        if (page.length === 0) break;
        all.push(...page);
        if (page.length < PAGE) break;
        offset += page.length;
      }
      return all;
    },
    async create(input) {
      const res = await callTool<{ entity?: AtlasEntity } | AtlasEntity>(
        "manage_entity",
        {
          action: "create",
          ...input,
        }
      );
      return unwrapEntity(res);
    },
    async update(input) {
      const res = await callTool<{ entity?: AtlasEntity } | AtlasEntity>(
        "manage_entity",
        {
          action: "update",
          ...input,
        }
      );
      return unwrapEntity(res);
    },
  };
}

function unwrapEntity(res: unknown): AtlasEntity {
  if (
    res &&
    typeof res === "object" &&
    "entity" in res &&
    (res as { entity?: unknown }).entity
  ) {
    return (res as { entity: AtlasEntity }).entity;
  }
  return res as AtlasEntity;
}

// ── Idempotent upsert ───────────────────────────────────────────────────

/**
 * Where a seeder's canonical key lives:
 *   - `'slug'`         — read `entity.slug` (top-level field)
 *   - `'metadata.foo'` — read `entity.metadata.foo`
 *   - bare `'foo'`     — read `entity.metadata.foo` (legacy alias)
 */
export type CanonicalKeyField = "slug" | `metadata.${string}` | string;

export interface UpsertSpec {
  entityType: string;
  /** A canonical, stable key per row (e.g. country iso3, city slug). */
  canonicalKey: string;
  name: string;
  slug?: string;
  parent_id?: number;
  metadata: Record<string, unknown>;
  /** Where the canonical key is read from on the server-side entity. */
  canonicalKeyField: CanonicalKeyField;
}

function readCanonicalKey(
  ent: AtlasEntity,
  field: CanonicalKeyField
): string | null {
  if (field === "slug") {
    return typeof ent.slug === "string" && ent.slug ? ent.slug : null;
  }
  const metaKey = field.startsWith("metadata.")
    ? field.slice("metadata.".length)
    : field;
  const v = ent.metadata?.[metaKey];
  if (typeof v === "string" || typeof v === "number") return String(v);
  return null;
}

/**
 * Build a key→entity map from a `list` result. Entities missing the
 * canonical key are silently dropped (they predate the seeder; we won't
 * touch them).
 */
export function indexByCanonicalKey(
  entities: AtlasEntity[],
  canonicalKeyField: CanonicalKeyField
): Map<string, AtlasEntity> {
  const out = new Map<string, AtlasEntity>();
  for (const ent of entities) {
    const key = readCanonicalKey(ent, canonicalKeyField);
    if (key !== null) out.set(key, ent);
  }
  return out;
}

/** True if the proposed entity diverges from what's already on the server. */
export function needsUpdate(
  existing: AtlasEntity,
  proposed: UpsertSpec
): boolean {
  if (existing.name !== proposed.name) return true;
  const before = existing.metadata ?? {};
  const after = proposed.metadata;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (!shallowEqual(before[k], after[k])) return true;
  }
  return false;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

// ── Rate-limited batch runner ───────────────────────────────────────────

/**
 * Run an array of async tasks with a soft requests-per-second ceiling.
 * Failures of individual tasks are caught + reported; the run never aborts.
 */
export async function runBatched<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  opts: { rateLimitPerSec: number; onError?: (err: unknown, item: T) => void }
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  const minSpacingMs = Math.max(
    1,
    Math.floor(1000 / Math.max(1, opts.rateLimitPerSec))
  );
  let last = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as T;
    const wait = minSpacingMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      results[i] = await worker(item, i);
    } catch (err) {
      results[i] = undefined;
      opts.onError?.(err, item);
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Seeder driver ───────────────────────────────────────────────────────

export interface SeederContext {
  client: AtlasClient | null; // null on dry-run
  options: SeederOptions;
  log: (...args: unknown[]) => void;
}

/**
 * Drive an idempotent upsert pass over a precomputed list of UpsertSpecs.
 * Looks up existing entities once, decides per-row to create/update/skip,
 * and returns a structured summary. On dry-run, logs the proposed payload
 * for each row instead of calling the API.
 */
export async function upsertEntities(
  ctx: SeederContext,
  entityType: string,
  specs: UpsertSpec[],
  canonicalKeyField: CanonicalKeyField
): Promise<SeedSummary> {
  const summary: SeedSummary = {
    entityType,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const limited = ctx.options.limit ? specs.slice(0, ctx.options.limit) : specs;

  if (ctx.options.dryRun || ctx.client === null) {
    ctx.log(`[dry-run] ${entityType}: ${limited.length} proposed payload(s)`);
    for (const spec of limited.slice(0, Math.min(limited.length, 5))) {
      ctx.log(
        `[dry-run] ${entityType} payload`,
        JSON.stringify(
          {
            entity_type: spec.entityType,
            name: spec.name,
            slug: spec.slug,
            parent_id: spec.parent_id,
            metadata: spec.metadata,
          },
          null,
          2
        )
      );
    }
    summary.created = limited.length;
    return summary;
  }

  const existing = await ctx.client.list(entityType);
  const byKey = indexByCanonicalKey(existing, canonicalKeyField);

  const rate = ctx.options.rateLimitPerSec ?? 50;
  const client = ctx.client;
  await runBatched(
    limited,
    async (spec) => {
      const found = byKey.get(spec.canonicalKey);
      if (!found) {
        await client.create({
          entity_type: spec.entityType,
          name: spec.name,
          slug: spec.slug,
          parent_id: spec.parent_id,
          metadata: spec.metadata,
        });
        summary.created++;
        return;
      }
      if (needsUpdate(found, spec)) {
        await client.update({
          entity_id: found.id,
          name: spec.name,
          slug: spec.slug,
          metadata: spec.metadata,
        });
        summary.updated++;
        return;
      }
      summary.skipped++;
    },
    {
      rateLimitPerSec: rate,
      onError: (err, spec) => {
        summary.failed++;
        summary.errors.push({
          key: spec.canonicalKey,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    }
  );

  return summary;
}

// ── Entity-type schema loader (verification-time only) ─────────────────

export interface EntityTypeSchema {
  slug: string;
  name: string;
  metadata_schema?: {
    type?: string;
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
}

/** Load and parse an entity-type YAML from examples/atlas/models/<slug>.yaml. */
export function loadAtlasEntityType(slug: string): EntityTypeSchema {
  const path = join(REPO_ROOT, "examples", "atlas", "models", `${slug}.yaml`);
  const raw = readFileSync(path, "utf8");
  return yaml.parse(raw) as EntityTypeSchema;
}

/**
 * Lightweight metadata validator for proposed seed payloads. Checks that
 * every metadata key is declared in the entity-type schema and that the
 * value's runtime type matches `properties[key].type`.
 *
 * This is intentionally a subset of full JSON Schema — just enough to
 * catch typos and type drift between the seeders and the YAMLs.
 */
export function validateMetadataAgainstSchema(
  schema: EntityTypeSchema,
  metadata: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const props = schema.metadata_schema?.properties ?? {};
  for (const [key, value] of Object.entries(metadata)) {
    const declared = props[key];
    if (!declared) {
      errors.push(`metadata.${key} is not declared in ${schema.slug}.yaml`);
      continue;
    }
    if (declared.type && !typeMatches(declared.type, value)) {
      errors.push(
        `metadata.${key}: expected ${declared.type}, got ${runtimeType(value)}`
      );
    }
    if (declared.enum && !declared.enum.includes(value as never)) {
      errors.push(
        `metadata.${key}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(declared.enum)}`
      );
    }
  }
  return errors;
}

function typeMatches(declared: string, value: unknown): boolean {
  if (value === null || value === undefined) return true; // optional fields
  switch (declared) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

function runtimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Logging ─────────────────────────────────────────────────────────────

export function makeLogger(prefix: string): (...args: unknown[]) => void {
  return (...args) => {
    // eslint-disable-next-line no-console
    console.log(`[${prefix}]`, ...args);
  };
}

// ── Cache helpers ───────────────────────────────────────────────────────

import { existsSync, mkdirSync, statSync } from "node:fs";

/**
 * Ensure CACHE_DIR exists; return absolute path to a cached file.
 * Callers populate the file via fetch + write or shell unzip; this just
 * normalizes paths and creates the dir.
 */
export function cachePath(filename: string): string {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  return join(CACHE_DIR, filename);
}

/** True if `path` exists, is non-empty, and is younger than `maxAgeDays`. */
export function isFreshCache(path: string, maxAgeDays: number): boolean {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (stat.size === 0) return false;
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs < maxAgeDays * 24 * 60 * 60 * 1000;
}

// ── Argument parsing ────────────────────────────────────────────────────

export interface RootArgs {
  only: Set<string> | null;
  dryRun: boolean;
  limit?: number;
}

export function parseRootArgs(argv: string[]): RootArgs {
  let only: Set<string> | null = null;
  let dryRun = false;
  let limit: number | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--only=")) {
      only = new Set(arg.slice("--only=".length).split(",").filter(Boolean));
    } else if (arg.startsWith("--limit=")) {
      limit = Number.parseInt(arg.slice("--limit=".length), 10);
    }
  }

  return { only, dryRun, limit };
}
