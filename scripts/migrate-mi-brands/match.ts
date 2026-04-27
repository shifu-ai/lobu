/**
 * scripts/migrate-mi-brands/match.ts
 *
 * Matching helpers: domain canonicalization + fuzzy name comparison.
 *
 * Two match strategies:
 *
 *   1. Domain match (preferred). Canonicalize the brand's domain (strip
 *      protocol / `www.` / trailing slash / path, lowercase). If the
 *      brand has no usable domain, fall through.
 *
 *   2. Name match (fallback). Normalize names (lowercase, strip
 *      Inc./LLC/Ltd./etc., collapse whitespace) and score with
 *      Jaro-Winkler. Single-best-match only — multiple candidates above
 *      `threshold` are reported as ambiguous and skipped.
 *
 * Both strategies are pure functions of the input — no I/O — so they
 * unit-test cleanly.
 */

// ── Domain ──────────────────────────────────────────────────────────────

/**
 * Reduce any of the common domain-bearing fields to a canonical lowercase
 * hostname, or `null` if nothing usable is present.
 *
 * Inputs we accept:
 *   - bare hostnames:           example.com
 *   - URLs:                     https://www.example.com/path?q=1
 *   - protocol-relative:        //example.com
 *   - trailing slashes:         example.com/
 *   - leading whitespace, mixed case, "www." prefix
 *
 * We deliberately keep subdomains other than `www.` intact so
 * `eu.example.com` and `example.com` don't collide.
 */
export function canonicalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let host = trimmed;
  // Strip protocol if present.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Strip protocol-relative // prefix.
  host = host.replace(/^\/\//, "");
  // Cut at first '/' or '?' or '#'.
  host = host.split(/[/?#]/, 1)[0] ?? "";
  // Cut user:pass@.
  host = host.replace(/^[^@]*@/, "");
  // Drop port suffix.
  host = host.replace(/:\d+$/, "");
  // Lowercase + strip leading "www.".
  host = host.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  // Reject anything that doesn't look like a hostname.
  if (!host?.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (host.endsWith(".")) host = host.replace(/\.+$/, "");
  return host || null;
}

/**
 * Pull a candidate domain string out of an entity's metadata. Tries every
 * plausible field MI / market might have written, in priority order, and
 * returns the *first* value that canonicalizes. Falls back to the first
 * non-empty raw value if none canonicalize, so the caller can still see
 * what the operator put in (and report it in the audit log).
 */
export function pickDomainFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null;
  const candidates = [
    "primary_domain",
    "domain",
    "homepage_url",
    "website",
    "website_url",
    "url",
  ];
  let firstNonEmpty: string | null = null;
  for (const k of candidates) {
    const v = metadata[k];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (firstNonEmpty === null) firstNonEmpty = trimmed;
    if (canonicalizeDomain(trimmed)) return trimmed;
  }
  return firstNonEmpty;
}

// ── Name normalization ──────────────────────────────────────────────────

/**
 * Suffixes we strip from company names before fuzzy-matching. Stored as
 * the *normalized* form (no punctuation, no spaces) — names are reduced
 * to that same form before suffix stripping, so dotted variants like
 * `L.L.C.` and bare `LLC` both match the same `llc` entry.
 */
const COMPANY_SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "ag",
  "sa",
  "plc",
  "bv",
  "nv",
  "oy",
  "ab",
  "kg",
  "kk",
];

/**
 * Lowercase, drop common company suffixes, collapse non-alphanumerics
 * into single spaces, trim. Idempotent.
 *
 * Suffix stripping happens *after* punctuation collapse, with one trick:
 * we also try treating each tail token's letters-only form as a suffix.
 * That way `L.L.C.` (→ `l l c` → letters-only `llc`) reduces correctly.
 */
export function normalizeName(input: unknown): string {
  if (typeof input !== "string") return "";
  let s = input.toLowerCase().normalize("NFKD");
  // Strip diacritics.
  s = s.replace(/[̀-ͯ]/g, "");
  // Replace any non-alphanumeric run with a single space.
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return "";

  // Strip company-form suffixes from the tail. Iterate so e.g.
  // "Foo Inc LLC" or "Foo, L.L.C." both come off.
  let changed = true;
  while (changed) {
    changed = false;
    const tokens = s.split(" ");
    if (tokens.length === 0) break;

    // Case 1: trailing whole token matches a suffix.
    const tail = tokens[tokens.length - 1] ?? "";
    if (COMPANY_SUFFIXES.includes(tail)) {
      tokens.pop();
      s = tokens.join(" ").trim();
      changed = true;
      continue;
    }

    // Case 2: trailing 2+ single-letter tokens, joined as letters-only,
    // form a suffix (handles `L.L.C.` → tokens `l l c` → `llc`).
    const trailingSingles: string[] = [];
    for (let i = tokens.length - 1; i >= 0 && tokens[i]?.length === 1; i--) {
      trailingSingles.unshift(tokens[i] as string);
    }
    if (trailingSingles.length >= 2) {
      const joined = trailingSingles.join("");
      if (COMPANY_SUFFIXES.includes(joined)) {
        s = tokens.slice(0, -trailingSingles.length).join(" ").trim();
        changed = true;
      }
    }
  }
  return s;
}

// ── Jaro-Winkler ────────────────────────────────────────────────────────

/**
 * Jaro similarity. Returns 0..1.
 * Reference: https://en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance
 */
function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(
    0,
    Math.floor(Math.max(a.length, b.length) / 2) - 1
  );
  const aMatches: boolean[] = new Array(a.length).fill(false);
  const bMatches: boolean[] = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions.
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  return (
    (matches / a.length +
      matches / b.length +
      (matches - transpositions) / matches) /
    3
  );
}

/**
 * Jaro-Winkler similarity with the standard 0.1 prefix scaling and a
 * common-prefix cap of 4 chars. Returns 0..1.
 */
export function jaroWinkler(a: string, b: string): number {
  const j = jaroSimilarity(a, b);
  if (j === 0) return 0;
  let prefix = 0;
  const max = Math.min(4, Math.min(a.length, b.length));
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

// ── High-level matching ─────────────────────────────────────────────────

export interface CompanyCandidate {
  id: number;
  name: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface MatchResult {
  /** What the matcher decided. */
  kind: "domain" | "name-fuzzy" | "ambiguous" | "no-match";
  /** The single chosen company (only set for `domain` and `name-fuzzy`). */
  company?: CompanyCandidate;
  /** The matching score for `name-fuzzy` (1.0 for `domain`). */
  score?: number;
  /** Set when `kind === 'ambiguous'` — every candidate at-or-above threshold. */
  candidates?: CompanyCandidate[];
  /** Best candidate's score we considered, even when no match passed.
   *  Surfaced into the audit log so operators can spot near-misses. */
  bestScore?: number;
  /** Diagnostic — what we actually canonicalized for the brand. */
  brandDomain?: string;
  brandNameNorm?: string;
}

export interface BrandLike {
  id: number;
  name: string;
  slug?: string;
  metadata?: Record<string, unknown>;
}

export interface MatchOptions {
  threshold: number;
  /** When set, restricts the search to one strategy. */
  matchOnly?: "domain" | "name" | "both";
}

/**
 * Match a single brand against the company corpus. Domain match wins
 * over fuzzy name match — we only fall through to fuzzy name matching
 * when the brand has no canonicalizable domain or no company shares it.
 *
 * Pure function. No I/O.
 */
export function matchBrand(
  brand: BrandLike,
  companies: CompanyCandidate[],
  opts: MatchOptions
): MatchResult {
  const matchOnly = opts.matchOnly ?? "both";
  const brandDomain = canonicalizeDomain(
    pickDomainFromMetadata(brand.metadata)
  );
  const brandNameNorm = normalizeName(brand.name);

  // Build a domain index over companies once.
  const byDomain = new Map<string, CompanyCandidate[]>();
  for (const c of companies) {
    const cd = canonicalizeDomain(pickDomainFromMetadata(c.metadata));
    if (!cd) continue;
    const list = byDomain.get(cd);
    if (list) list.push(c);
    else byDomain.set(cd, [c]);
  }

  if (matchOnly !== "name" && brandDomain) {
    const hits = byDomain.get(brandDomain) ?? [];
    if (hits.length === 1) {
      return {
        kind: "domain",
        company: hits[0],
        score: 1,
        brandDomain,
        brandNameNorm,
      };
    }
    if (hits.length > 1) {
      return {
        kind: "ambiguous",
        candidates: hits,
        score: 1,
        brandDomain,
        brandNameNorm,
      };
    }
  }

  if (matchOnly === "domain") {
    return { kind: "no-match", brandDomain, brandNameNorm };
  }

  // Fuzzy name match. Empty / nameless brands skip.
  if (!brandNameNorm) {
    return { kind: "no-match", brandDomain, brandNameNorm };
  }

  let bestScore = 0;
  const aboveThreshold: Array<{ company: CompanyCandidate; score: number }> =
    [];
  for (const c of companies) {
    const cn = normalizeName(c.name);
    if (!cn) continue;
    const score = jaroWinkler(brandNameNorm, cn);
    if (score > bestScore) bestScore = score;
    if (score >= opts.threshold) aboveThreshold.push({ company: c, score });
  }

  if (aboveThreshold.length === 0) {
    return {
      kind: "no-match",
      bestScore,
      brandDomain,
      brandNameNorm,
    };
  }

  if (aboveThreshold.length > 1) {
    // Single-best-match only: any case with >1 candidates at-or-above the
    // threshold is ambiguous and skipped. Operators raise the threshold
    // (or use --match-only=domain) if they want stricter matching.
    aboveThreshold.sort((a, b) => b.score - a.score);
    const top = aboveThreshold[0]!;
    return {
      kind: "ambiguous",
      candidates: aboveThreshold.map((a) => a.company),
      score: top.score,
      brandDomain,
      brandNameNorm,
    };
  }

  const only = aboveThreshold[0]!;
  return {
    kind: "name-fuzzy",
    company: only.company,
    score: only.score,
    brandDomain,
    brandNameNorm,
  };
}
