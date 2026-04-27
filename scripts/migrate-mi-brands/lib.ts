/**
 * scripts/migrate-mi-brands/lib.ts
 *
 * Shared infrastructure for the brand-merge migration. The migration is a
 * one-time pass that walks every `market-intelligence.brand` and either
 *  - merges it into a matched `market.company`, OR
 *  - creates a new `market.company` carrying the brand's fields.
 *
 * Cross-org access via the Owletto REST tool-proxy:
 *
 *   POST {OWLETTO_BASE_URL}/api/{orgSlug}/{toolName}
 *   Authorization: Bearer ${OWLETTO_API_TOKEN}
 *
 * The same shape the Atlas seeders use (see `scripts/seed-atlas/lib.ts`),
 * just parameterized by `orgSlug` so we can read MI and write market in
 * the same run.
 *
 * Read-only by default. The runner must be invoked with `--apply` to
 * make any write — every other code path is dry-run.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ───────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root resolved from this file's location. */
export const REPO_ROOT = resolve(__dirname, "..", "..");

/** Audit log directory — append-only JSONL, one file per run. */
export const LOGS_DIR = join(__dirname, "logs");

// ── Types ───────────────────────────────────────────────────────────────

export interface OwlettoEntity {
  id: number;
  name: string;
  slug?: string;
  entity_type?: string;
  metadata?: Record<string, unknown>;
}

export interface OwlettoRelationship {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  relationship_type_slug: string;
  metadata?: Record<string, unknown> | null;
  confidence?: number;
  source?: string;
}

export interface CreateEntityInput {
  entity_type: string;
  name: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateEntityInput {
  entity_id: number;
  name?: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateLinkInput {
  from_entity_id: number;
  to_entity_id: number;
  relationship_type_slug: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: "ui" | "llm" | "feed" | "api";
}

/**
 * Per-org REST client. Construct one for `market-intelligence` (reads) and
 * one for `market` (writes). Both share the same backend base URL + token;
 * the org slug just flips which org's endpoint we hit.
 */
export interface OrgClient {
  readonly orgSlug: string;
  listEntities(entity_type: string): Promise<OwlettoEntity[]>;
  getEntity(entity_id: number): Promise<OwlettoEntity | null>;
  createEntity(input: CreateEntityInput): Promise<OwlettoEntity>;
  updateEntity(input: UpdateEntityInput): Promise<OwlettoEntity>;
  /** List outbound + inbound links for `entity_id`, optionally filtered by type. */
  listLinks(args: {
    entity_id: number;
    relationship_type_slug?: string;
  }): Promise<OwlettoRelationship[]>;
  createLink(input: CreateLinkInput): Promise<OwlettoRelationship>;
  unlink(relationship_id: number): Promise<void>;
}

// ── HTTP-backed OrgClient ───────────────────────────────────────────────

interface ToolError {
  error?: string;
}

export interface CreateOrgClientOpts {
  baseUrl?: string;
  token?: string;
  orgSlug: string;
}

export function createHttpOrgClient(opts: CreateOrgClientOpts): OrgClient {
  const baseUrl = (opts.baseUrl ?? process.env.OWLETTO_BASE_URL ?? "").replace(
    /\/+$/,
    ""
  );
  const token = opts.token ?? process.env.OWLETTO_API_TOKEN ?? "";
  const orgSlug = opts.orgSlug;

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
  if (!orgSlug) {
    throw new Error("orgSlug is required");
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
    orgSlug,
    async listEntities(entity_type) {
      const all: OwlettoEntity[] = [];
      const PAGE = 200;
      let offset = 0;
      // Defensive cap; far above any single-org brand list we'd see.
      const MAX = 100_000;
      while (offset < MAX) {
        const res = (await callTool<{ entities?: OwlettoEntity[] }>(
          "manage_entity",
          { action: "list", entity_type, limit: PAGE, offset }
        )) ?? { entities: [] };
        const page = res.entities ?? [];
        if (page.length === 0) break;
        all.push(...page);
        if (page.length < PAGE) break;
        offset += page.length;
      }
      return all;
    },
    async getEntity(entity_id) {
      try {
        const res = await callTool<{ entity?: OwlettoEntity } | OwlettoEntity>(
          "manage_entity",
          { action: "get", entity_id }
        );
        return unwrapEntity(res);
      } catch (err) {
        // Treat HTTP 404 / "not found" as a soft miss; everything else is
        // a real error the caller needs to see (auth / 5xx / network).
        const msg = err instanceof Error ? err.message : String(err);
        if (/→\s*404/.test(msg) || /not found/i.test(msg)) return null;
        throw err;
      }
    },
    async createEntity(input) {
      const res = await callTool<{ entity?: OwlettoEntity } | OwlettoEntity>(
        "manage_entity",
        { action: "create", ...input }
      );
      const entity = unwrapEntity(res);
      if (!entity) {
        throw new Error(`createEntity returned no entity for ${input.name}`);
      }
      return entity;
    },
    async updateEntity(input) {
      const res = await callTool<{ entity?: OwlettoEntity } | OwlettoEntity>(
        "manage_entity",
        { action: "update", ...input }
      );
      const entity = unwrapEntity(res);
      if (!entity) {
        throw new Error(
          `updateEntity returned no entity for ${input.entity_id}`
        );
      }
      return entity;
    },
    async listLinks(args) {
      const all: OwlettoRelationship[] = [];
      const PAGE = 200;
      let offset = 0;
      // Hard cap so a runaway server can't loop us forever; far above any
      // single-entity mention count we'd see in MI.
      const MAX = 50_000;
      while (offset < MAX) {
        const res = (await callTool<{
          relationships?: OwlettoRelationship[];
        }>("manage_entity", {
          action: "list_links",
          entity_id: args.entity_id,
          relationship_type_slug: args.relationship_type_slug,
          direction: "both",
          limit: PAGE,
          offset,
        })) ?? { relationships: [] };
        const page = res.relationships ?? [];
        if (page.length === 0) break;
        all.push(...page);
        if (page.length < PAGE) break;
        offset += page.length;
      }
      return all;
    },
    async createLink(input) {
      const res = await callTool<{
        relationship?: OwlettoRelationship;
      }>("manage_entity", { action: "link", ...input });
      const link = res?.relationship;
      if (!link) {
        throw new Error("createLink: no relationship returned");
      }
      return link;
    },
    async unlink(relationship_id) {
      await callTool<{ success: boolean }>("manage_entity", {
        action: "unlink",
        relationship_id,
      });
    },
  };
}

function unwrapEntity(res: unknown): OwlettoEntity | null {
  if (!res || typeof res !== "object") return null;
  if ("entity" in res && (res as { entity?: unknown }).entity) {
    return (res as { entity: OwlettoEntity }).entity;
  }
  if ("id" in res && "name" in res) {
    return res as OwlettoEntity;
  }
  return null;
}

// ── Audit log ───────────────────────────────────────────────────────────

export type Decision =
  | "merged-domain"
  | "merged-name-fuzzy"
  | "created"
  | "ambiguous-skipped"
  | "create-failed"
  | "merge-failed"
  | "mention-retargeted"
  | "mention-skipped"
  | "noop";

export interface AuditEntry {
  ts: string;
  decision: Decision;
  brand_id?: number;
  brand_name?: string;
  brand_slug?: string;
  company_id?: number;
  company_name?: string;
  company_slug?: string;
  /** Match score, 0..1 — present for fuzzy / ambiguous decisions. */
  score?: number;
  /** Candidate ids when ambiguous. */
  candidate_ids?: number[];
  /** Mention id when retargeting. */
  mention_id?: number;
  /** True when --dry-run. */
  dry_run: boolean;
  /** Reason / human-readable note. */
  reason?: string;
}

/** Wraps the logfile + console mirror. Rotates once per run. */
export interface AuditLog {
  /** Append a structured entry; mirrored to console. */
  record(
    entry: Omit<AuditEntry, "ts" | "dry_run"> & { dry_run?: boolean }
  ): void;
  /** Path of the JSONL file being written. */
  readonly path: string;
  /** Flush + return a path summary line for end-of-run printing. */
  finalize(): { path: string; count: number };
}

export interface AuditLogOptions {
  dryRun: boolean;
  dir?: string;
  /** Override the timestamp portion of the filename — used in tests. */
  filename?: string;
}

export function createAuditLog(opts: AuditLogOptions): AuditLog {
  const dir = opts.dir ?? LOGS_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fname =
    opts.filename ??
    `migrate-${opts.dryRun ? "dryrun" : "apply"}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.jsonl`;
  const path = join(dir, fname);
  let count = 0;

  function record(
    e: Omit<AuditEntry, "ts" | "dry_run"> & { dry_run?: boolean }
  ): void {
    const full: AuditEntry = {
      ts: new Date().toISOString(),
      dry_run: e.dry_run ?? opts.dryRun,
      ...e,
    };
    appendFileSync(path, `${JSON.stringify(full)}\n`);
    count++;
    // eslint-disable-next-line no-console
    console.log(
      `[mi-migrate] ${full.decision}${
        full.brand_id !== undefined ? ` brand=${full.brand_id}` : ""
      }${full.company_id !== undefined ? ` company=${full.company_id}` : ""}${
        full.score !== undefined ? ` score=${full.score.toFixed(3)}` : ""
      }${full.reason ? ` (${full.reason})` : ""}`
    );
  }

  return {
    record,
    get path() {
      return path;
    },
    finalize() {
      return { path, count };
    },
  };
}

/**
 * Read every entry of a previous JSONL log and return them. Used by the
 * idempotency-check tests; also occasionally useful for ops review.
 */
export function readAuditLog(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

// ── Argument parsing ────────────────────────────────────────────────────

export interface RootArgs {
  /** When false, default — log proposed payloads, make no writes. */
  apply: boolean;
  dryRun: boolean;
  /** Cap the number of brands processed. */
  limit?: number;
  /** Restrict matching to one strategy. Default = both. */
  matchOnly: "domain" | "name" | "both";
  /** Fuzzy name threshold; below = skip. Default 0.92. */
  threshold: number;
  /** Override source/target org slugs. Useful for tests + staging. */
  sourceOrg: string;
  targetOrg: string;
}

export function parseRootArgs(argv: string[]): RootArgs {
  let applyFlag = false;
  let dryRunFlag = false;
  let limit: number | undefined;
  let matchOnly: RootArgs["matchOnly"] = "both";
  let threshold = 0.92;
  let sourceOrg = "market-intelligence";
  let targetOrg = "market";

  for (const arg of argv) {
    if (arg === "--apply") applyFlag = true;
    else if (arg === "--dry-run") dryRunFlag = true;
    else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length);
      const v = Number.parseInt(raw, 10);
      if (!Number.isFinite(v) || v <= 0 || String(v) !== raw.trim()) {
        throw new Error(`--limit must be a positive integer, got ${arg}`);
      }
      limit = v;
    } else if (arg.startsWith("--match-only=")) {
      const v = arg.slice("--match-only=".length);
      if (v === "domain" || v === "name" || v === "both") matchOnly = v;
      else throw new Error(`--match-only must be domain|name|both, got ${v}`);
    } else if (arg.startsWith("--threshold=")) {
      const v = Number.parseFloat(arg.slice("--threshold=".length));
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`--threshold must be in [0,1], got ${arg}`);
      }
      threshold = v;
    } else if (arg.startsWith("--source-org=")) {
      const v = arg.slice("--source-org=".length);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
        throw new Error(`--source-org must be a slug ([a-z0-9-]+), got ${arg}`);
      }
      sourceOrg = v;
    } else if (arg.startsWith("--target-org=")) {
      const v = arg.slice("--target-org=".length);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
        throw new Error(`--target-org must be a slug ([a-z0-9-]+), got ${arg}`);
      }
      targetOrg = v;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  // --dry-run wins when both passed: an explicit --dry-run never makes
  // writes, even if --apply is also present. Default (neither passed) is
  // dry-run for safety.
  const apply = applyFlag && !dryRunFlag;
  const dryRun = !apply;

  return {
    apply,
    dryRun,
    ...(limit !== undefined ? { limit } : {}),
    matchOnly,
    threshold,
    sourceOrg,
    targetOrg,
  };
}

// ── Logging ─────────────────────────────────────────────────────────────

export function makeLogger(prefix: string): (...args: unknown[]) => void {
  return (...args) => {
    // eslint-disable-next-line no-console
    console.log(`[${prefix}]`, ...args);
  };
}

// ── Rate-limited batch runner (mirrors seed-atlas/lib.ts) ───────────────

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
  return new Promise((r) => setTimeout(r, ms));
}

// ── Re-exports for callers ──────────────────────────────────────────────

export { writeFileSync, readFileSync };
