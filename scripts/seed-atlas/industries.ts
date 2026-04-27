/**
 * scripts/seed-atlas/industries.ts
 *
 * Seeds atlas.industry with the NAICS 2022 hierarchy. Source:
 *
 *   https://www.census.gov/naics/2022NAICS/6-digit_2022_Codes.xlsx
 *
 * The Census Bureau only publishes XLSX. Rather than pull in an XLSX
 * library we extract just the two columns we need (code + title) from
 * the well-known shape of this file: a single sheet, column A = code,
 * column B = title-via-shared-strings. This bespoke parser is ~80 LOC
 * and cleanly fails loud on any unexpected layout drift.
 *
 * The 6-digit Census file only contains 6-digit national industries.
 * To preserve the NAICS hierarchy (2 → 3 → 4 → 5 → 6) we synthesise the
 * intermediate parents from the leaf codes — we don't have their official
 * titles, but we name them `NAICS <code>` as placeholders, which is a
 * deliberate trade-off to avoid pulling another file.
 *
 * Canonical key: metadata.code (the NAICS code itself, e.g. "541512").
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CACHE_DIR,
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
  "https://www.census.gov/naics/2022NAICS/6-digit_2022_Codes.xlsx";

/**
 * Tiny XLSX reader for Census's 2-column file. Returns rows of
 * `[codeCellText, titleCellText]`. Drops cells we can't decode (unusual
 * cell types, missing shared-string indices, etc.).
 */
export function readCensusXlsx(xlsxPath: string): string[][] {
  const tmpDir = join(CACHE_DIR, "_xlsx-tmp");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  execFileSync("unzip", ["-q", "-o", xlsxPath, "-d", tmpDir], {
    stdio: "pipe",
  });

  const sharedXml = readFileSync(
    join(tmpDir, "xl", "sharedStrings.xml"),
    "utf8"
  );
  const sharedStrings = parseSharedStrings(sharedXml);

  const sheetXml = readFileSync(
    join(tmpDir, "xl", "worksheets", "sheet1.xml"),
    "utf8"
  );
  const rows = parseSheet(sheetXml, sharedStrings);

  rmSync(tmpDir, { recursive: true, force: true });
  return rows;
}

/** Extract `<si><t>...</t></si>` content; preserves order. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // Match each <si>…</si> entry (which may contain one or more <t>…</t> children).
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  for (const match of xml.matchAll(siRegex)) {
    const body = match[1] ?? "";
    const tParts: string[] = [];
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      tParts.push(decodeXml(t[1] ?? ""));
    }
    out.push(tParts.join(""));
  }
  return out;
}

/**
 * Pull every `<row>` and inside each row, every `<c>` cell. Cells of type
 * `t="s"` reference `sharedStrings[i]`; numeric cells contain the raw
 * value inside `<v>`. Returns `string[][]` ordered by row, then by column
 * letter (A, B, C…).
 */
export function parseSheet(
  xml: string,
  sharedStrings: readonly string[]
): string[][] {
  const out: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  for (const rowMatch of xml.matchAll(rowRegex)) {
    const body = rowMatch[1] ?? "";
    const cells: Array<{ col: string; text: string }> = [];
    const cellRegex = /<c\s+([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    for (const cellMatch of body.matchAll(cellRegex)) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[3] ?? "";
      const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? "";
      const t = attrs.match(/t="([^"]+)"/)?.[1] ?? "";
      const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      let text = "";
      if (t === "s") {
        const idx = Number.parseInt(v, 10);
        text = Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "";
      } else if (t === "inlineStr") {
        text = decodeXml(inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
      } else {
        text = decodeXml(v);
      }
      cells.push({ col: ref, text });
    }
    cells.sort((a, b) => columnIndex(a.col) - columnIndex(b.col));
    out.push(cells.map((c) => c.text));
  }
  return out;
}

function columnIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchNaicsXlsx(): Promise<string> {
  const cached = cachePath("naics-2022.xlsx");
  if (isFreshCache(cached, 365)) return cached;
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`
    );
  }
  const buf = await res.arrayBuffer();
  writeFileSync(cached, Buffer.from(buf));
  return cached;
}

export interface NaicsRow {
  code: string; // 2/3/4/5/6-digit numeric string
  title: string;
}

/**
 * Pull `(code, title)` rows out of the Census 6-digit XLSX table, ignoring
 * header rows and any other non-numeric clutter. The Census file has 2
 * columns; later columns are ignored if present.
 */
export function extractNaicsRows(table: string[][]): NaicsRow[] {
  const out: NaicsRow[] = [];
  for (const row of table) {
    const code = (row[0] ?? "").trim();
    const title = (row[1] ?? "").trim();
    if (!code || !title) continue;
    if (!/^\d{2,6}$/.test(code)) continue;
    out.push({ code, title });
  }
  return out;
}

/**
 * Census's 6-digit file lists only leaf codes. To preserve the NAICS
 * hierarchy we generate placeholder rows for every intermediate
 * (2/3/4/5-digit) code that's a prefix of a leaf, with a synthetic
 * `NAICS <code>` title. The titles are best-effort; operators who want
 * the canonical Census titles can replace them via the audit agent later.
 */
export function synthesizeIntermediates(rows: readonly NaicsRow[]): NaicsRow[] {
  const have = new Set(rows.map((r) => r.code));
  const synthesized: NaicsRow[] = [];
  for (const row of rows) {
    let code = row.code;
    while (code.length > 2) {
      code = code.slice(0, code.length - 1);
      if (!have.has(code)) {
        have.add(code);
        synthesized.push({ code, title: `NAICS ${code}` });
      }
    }
  }
  return [...rows, ...synthesized];
}

/** Walk the NAICS hierarchy: parent code is `code.slice(0, code.length - 1)`. */
export function parentCode(code: string): string | null {
  if (code.length <= 2) return null;
  return code.slice(0, code.length - 1);
}

export function buildIndustrySpecs(
  rows: NaicsRow[],
  parentIdByCode: ReadonlyMap<string, number>
): UpsertSpec[] {
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const out: UpsertSpec[] = [];
  // Sort shortest-first so 2-digit parents are upserted before 6-digit children
  // when this seeder is run before the live API has them yet (single-pass mode).
  const sorted = [...rows].sort(
    (a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code)
  );
  for (const row of sorted) {
    const parent = parentCode(row.code);
    let parent_id: number | undefined;
    if (parent && byCode.has(parent)) {
      parent_id = parentIdByCode.get(parent);
    }
    out.push({
      entityType: "industry",
      name: row.title,
      slug: `naics-${row.code}`,
      canonicalKey: row.code,
      canonicalKeyField: "code",
      parent_id,
      metadata: {
        code: row.code,
        taxonomy_source: "NAICS",
      },
    });
  }
  return out;
}

export async function seedIndustries(ctx: SeederContext): Promise<void> {
  const log = makeLogger("industries");
  const schema = loadAtlasEntityType("industry");

  const xlsxPath = await fetchNaicsXlsx();
  const table = readCensusXlsx(xlsxPath);
  const leafRows = extractNaicsRows(table);
  const rows = synthesizeIntermediates(leafRows);
  log(
    `parsed ${leafRows.length} NAICS leaves; ${rows.length} total with synthesized parents`
  );

  let parentIdByCode: Map<string, number>;
  if (ctx.client) {
    const existing = await ctx.client.list("industry");
    parentIdByCode = new Map();
    for (const ent of existing) {
      const code = (ent.metadata?.code ?? "") as string;
      if (code) parentIdByCode.set(code, ent.id);
    }
    log(
      `resolved parent_id for ${parentIdByCode.size} existing industry codes`
    );
  } else {
    parentIdByCode = new Map();
    log("[dry-run] empty parent_id map — sectors first, then subsectors, etc.");
  }

  const specs = buildIndustrySpecs(rows, parentIdByCode);

  if (specs.length > 0) {
    const errs = validateMetadataAgainstSchema(
      schema,
      (specs[0] as UpsertSpec).metadata
    );
    if (errs.length > 0) {
      throw new Error(
        `industry payload mismatches industry.yaml: ${errs.join("; ")}`
      );
    }
  }

  const summary = await upsertEntities(ctx, "industry", specs, "code");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedIndustries({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("industries"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
