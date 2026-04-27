/**
 * scripts/migrate-mi-brands/merge.ts
 *
 * Pure merge logic. Produces a proposed new metadata object given:
 *   - the existing market.company metadata
 *   - the brand fields extracted from market-intelligence.brand
 *
 * Contract — only fill in *missing* values on the company side. We never
 * overwrite a field the operator (or a prior run) has already populated.
 *
 * Brand fields covered (per `examples/market/models/company.yaml`):
 *   - logo_url      (string, format: uri)
 *   - tagline       (string)
 *   - brand_voice   (string)
 *   - social_handles (object: twitter, linkedin, github, youtube, instagram, tiktok)
 *
 * Anything else on the brand is dropped. We don't speculatively add new
 * keys — the company schema is the authoritative shape.
 */

// ── Types ───────────────────────────────────────────────────────────────

export interface BrandFields {
  logo_url?: string;
  tagline?: string;
  brand_voice?: string;
  social_handles?: SocialHandles;
}

export interface SocialHandles {
  twitter?: string;
  linkedin?: string;
  github?: string;
  youtube?: string;
  instagram?: string;
  tiktok?: string;
}

const SOCIAL_KEYS: ReadonlyArray<keyof SocialHandles> = Object.freeze([
  "twitter",
  "linkedin",
  "github",
  "youtube",
  "instagram",
  "tiktok",
]);

// ── Brand-field extraction ──────────────────────────────────────────────

/**
 * Pull brand-relevant fields out of an MI brand entity's metadata. Tries
 * a couple of plausible synonyms for each field — MI's brand schema in
 * `examples/market-intelligence/models/brand.yaml` doesn't enforce these
 * column names, so we look across common shapes.
 */
export function extractBrandFields(
  metadata: Record<string, unknown> | null | undefined
): BrandFields {
  if (!metadata) return {};
  const out: BrandFields = {};

  const logo = stringField(metadata, ["logo_url", "logoUrl", "logo"]);
  if (logo) out.logo_url = logo;

  const tagline = stringField(metadata, ["tagline", "headline", "positioning"]);
  if (tagline) out.tagline = tagline;

  const voice = stringField(metadata, [
    "brand_voice",
    "brandVoice",
    "voice",
    "tone_of_voice",
  ]);
  if (voice) out.brand_voice = voice;

  const handles = extractSocialHandles(metadata);
  if (Object.keys(handles).length > 0) out.social_handles = handles;

  return out;
}

function stringField(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function extractSocialHandles(
  metadata: Record<string, unknown>
): SocialHandles {
  const out: SocialHandles = {};
  // Direct nested object form.
  const nested = metadata.social_handles ?? metadata.socialHandles;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    for (const k of SOCIAL_KEYS) {
      const v = (nested as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  }
  // Flat `*_handle` / `*_url` siblings — some MI rows store them flat.
  const flat: Array<[keyof SocialHandles, string[]]> = [
    ["twitter", ["twitter", "twitter_handle", "twitter_url", "x_handle"]],
    ["linkedin", ["linkedin", "linkedin_url", "linkedin_handle"]],
    ["github", ["github", "github_handle", "github_url"]],
    ["youtube", ["youtube", "youtube_url", "youtube_channel"]],
    ["instagram", ["instagram", "instagram_handle", "instagram_url"]],
    ["tiktok", ["tiktok", "tiktok_handle", "tiktok_url"]],
  ];
  for (const [key, names] of flat) {
    if (out[key]) continue;
    const v = stringField(metadata, names);
    if (v) out[key] = v;
  }
  return out;
}

// ── Merge ───────────────────────────────────────────────────────────────

export interface MergeResult {
  /** New metadata object — pass straight into `updateEntity`. */
  metadata: Record<string, unknown>;
  /** True if anything changed (decides whether to call the API at all). */
  changed: boolean;
  /** Field names whose values were filled in by this merge. */
  filledFields: string[];
}

/**
 * Merge brand fields into an existing company metadata object. Only fills
 * in missing values — never overwrites.
 *
 *   "missing" = key absent, value `null` / `undefined` / empty string.
 *
 * For `social_handles`, treats the object as a set of keys: only the
 * specific subkeys absent on the company are filled.
 */
export function mergeBrandIntoCompany(
  companyMetadata: Record<string, unknown> | null | undefined,
  brand: BrandFields
): MergeResult {
  const result: Record<string, unknown> = { ...(companyMetadata ?? {}) };
  const filled: string[] = [];
  let changed = false;

  if (brand.logo_url && !nonEmptyString(result.logo_url)) {
    result.logo_url = brand.logo_url;
    filled.push("logo_url");
    changed = true;
  }
  if (brand.tagline && !nonEmptyString(result.tagline)) {
    result.tagline = brand.tagline;
    filled.push("tagline");
    changed = true;
  }
  if (brand.brand_voice && !nonEmptyString(result.brand_voice)) {
    result.brand_voice = brand.brand_voice;
    filled.push("brand_voice");
    changed = true;
  }

  if (brand.social_handles) {
    const existing = isObject(result.social_handles)
      ? { ...(result.social_handles as Record<string, unknown>) }
      : {};
    let socialChanged = false;
    for (const k of SOCIAL_KEYS) {
      const incoming = brand.social_handles[k];
      if (!incoming) continue;
      if (nonEmptyString(existing[k])) continue;
      existing[k] = incoming;
      filled.push(`social_handles.${k}`);
      socialChanged = true;
    }
    if (socialChanged) {
      result.social_handles = existing;
      changed = true;
    }
  }

  return { metadata: result, changed, filledFields: filled };
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ── Initial company payload (no-match path) ────────────────────────────

/**
 * Build the metadata payload for a *new* company entity created from a
 * brand the migration couldn't match. Drops empty values + flattens
 * social_handles into the same shape `mergeBrandIntoCompany` would.
 */
export function brandToNewCompanyMetadata(
  brand: BrandFields
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (brand.logo_url) out.logo_url = brand.logo_url;
  if (brand.tagline) out.tagline = brand.tagline;
  if (brand.brand_voice) out.brand_voice = brand.brand_voice;
  if (brand.social_handles) {
    const handles: Record<string, string> = {};
    for (const k of SOCIAL_KEYS) {
      const v = brand.social_handles[k];
      if (v) handles[k] = v;
    }
    if (Object.keys(handles).length > 0) out.social_handles = handles;
  }
  return out;
}
