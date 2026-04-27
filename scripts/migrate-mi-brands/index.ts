/**
 * scripts/migrate-mi-brands/index.ts
 *
 * One-time migration: walk every `market-intelligence.brand`, match
 * against `market.company`, then merge the brand fields in (or create a
 * new company when nothing matches). Re-target MI's `mentions`
 * relationships at the corresponding market.company.
 *
 * Default behavior is **dry-run** — no writes. `--apply` is required to
 * make any modification.
 *
 * Usage:
 *   bun run scripts/migrate-mi-brands/index.ts                  # dry-run
 *   bun run scripts/migrate-mi-brands/index.ts --dry-run        # explicit
 *   bun run scripts/migrate-mi-brands/index.ts --limit=10       # cap brands
 *   bun run scripts/migrate-mi-brands/index.ts --match-only=domain
 *   bun run scripts/migrate-mi-brands/index.ts --threshold=0.95
 *   bun run scripts/migrate-mi-brands/index.ts --apply          # live
 *
 * Env:
 *   OWLETTO_BASE_URL    e.g. https://owletto.example.com
 *   OWLETTO_API_TOKEN   PAT or OAuth bearer with read on market-intelligence
 *                        and write on market
 *
 * After every brand has been processed, the script prints — but does
 * NOT run — the final SQL statement to archive the source org.
 */

import {
  type AuditLog,
  createAuditLog,
  createHttpOrgClient,
  makeLogger,
  type OrgClient,
  parseRootArgs,
  type RootArgs,
  runBatched,
} from "./lib.ts";
import {
  type BrandLike,
  canonicalizeDomain,
  type CompanyCandidate,
  matchBrand,
  type MatchResult,
  pickDomainFromMetadata,
} from "./match.ts";
import {
  brandToNewCompanyMetadata,
  extractBrandFields,
  mergeBrandIntoCompany,
} from "./merge.ts";

// ── Public types ────────────────────────────────────────────────────────

export interface MigrationDeps {
  /** Read MI brands + relationships. */
  source: OrgClient;
  /** Read + write market companies + relationships. */
  target: OrgClient;
  /** Audit logger — call `record()` for each decision. */
  audit: AuditLog;
  /** When false, no writes are made. */
  apply: boolean;
  threshold: number;
  matchOnly: "domain" | "name" | "both";
  limit?: number;
  rateLimitPerSec?: number;
  log: (...args: unknown[]) => void;
}

export interface MigrationSummary {
  scanned: number;
  mergedDomain: number;
  mergedFuzzy: number;
  created: number;
  ambiguous: number;
  noop: number;
  /** Mention re-targeting subtotals. */
  mentionsRetargeted: number;
  mentionsSkipped: number;
  /** Path to the JSONL audit log file. */
  auditLogPath: string;
}

interface BrandMapping {
  brand: BrandLike;
  /** Resolved company id, or null if we couldn't (ambiguous / errored). */
  companyId: number | null;
  decision:
    | "merged-domain"
    | "merged-fuzzy"
    | "merge-noop"
    | "created"
    | "ambiguous";
}

// Sentinel-id counter for dry-run "would create" companies — kept in a
// closure cell so each runMigration call gets a fresh range starting at -1.
// Re-set inside runMigration (lexically below).
let nextDryRunId = 0;

// ── Driver ──────────────────────────────────────────────────────────────

export async function runMigration(
  deps: MigrationDeps
): Promise<MigrationSummary> {
  // Reset dry-run id counter for this run.
  nextDryRunId = 0;

  const summary: MigrationSummary = {
    scanned: 0,
    mergedDomain: 0,
    mergedFuzzy: 0,
    created: 0,
    ambiguous: 0,
    noop: 0,
    mentionsRetargeted: 0,
    mentionsSkipped: 0,
    auditLogPath: deps.audit.path,
  };

  deps.log("loading market-intelligence brands");
  const brandsAll = await deps.source.listEntities("brand");
  const brands = deps.limit ? brandsAll.slice(0, deps.limit) : brandsAll;
  deps.log(`scanning ${brands.length} brand(s)`);

  deps.log("loading market companies");
  const companies = await deps.target.listEntities("company");
  deps.log(`indexed ${companies.length} company(ies)`);

  // brand_id → resolved market.company.id (or null if skipped). Used in
  // mention re-targeting below.
  const brandToCompany = new Map<number, number | null>();

  const rate = deps.rateLimitPerSec ?? 25;
  await runBatched(
    brands,
    async (brand) => {
      summary.scanned++;
      const mapping = await processBrand(brand, companies, deps, summary);
      brandToCompany.set(brand.id, mapping.companyId);
    },
    {
      rateLimitPerSec: rate,
      onError: (err, brand) => {
        deps.log(
          `[error] processing brand ${brand.id} ${brand.name}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      },
    }
  );

  // ── Mention re-target pass ────────────────────────────────────────
  await retargetMentions(brandToCompany, deps, summary);

  // Final report + manual archive instruction.
  deps.log("");
  deps.log("=== migration summary ===");
  deps.log(JSON.stringify(summary, null, 2));
  deps.log("");
  deps.log("Final operator step (NOT executed by this script):");
  deps.log(
    `  UPDATE organization SET visibility='archived' WHERE slug='${deps.source.orgSlug}';`
  );

  deps.audit.finalize();
  return summary;
}

async function processBrand(
  brand: BrandLike,
  companies: CompanyCandidate[],
  deps: MigrationDeps,
  summary: MigrationSummary
): Promise<BrandMapping> {
  const result = matchBrand(brand, companies, {
    threshold: deps.threshold,
    matchOnly: deps.matchOnly,
  });

  switch (result.kind) {
    case "domain":
    case "name-fuzzy": {
      return await mergeIntoCompany(brand, result, deps, summary);
    }

    case "ambiguous": {
      summary.ambiguous++;
      const candidates = result.candidates ?? [];
      // Domain ambiguity wins at score=1 (multiple companies share a
      // canonical domain). Fuzzy ambiguity is multiple names above the
      // threshold. Distinguishing the two helps operator triage.
      const isDomainAmbiguity = result.score === 1;
      deps.audit.record({
        decision: "ambiguous-skipped",
        brand_id: brand.id,
        brand_name: brand.name,
        ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
        score: result.score ?? 0,
        candidate_ids: candidates.map((c) => c.id),
        reason: isDomainAmbiguity
          ? `${candidates.length} companies share canonical domain ${result.brandDomain ?? "(unknown)"}`
          : `${candidates.length} fuzzy-name candidates above threshold ${deps.threshold}`,
      });
      return { brand, companyId: null, decision: "ambiguous" };
    }

    case "no-match": {
      // Below threshold or nothing close — create a new company. We carry
      // the best fuzzy score (if any) into the audit log so operators
      // can spot near-misses that arguably *should* have merged.
      return await createCompanyFromBrand(
        brand,
        companies,
        deps,
        summary,
        result.bestScore
      );
    }
  }
}

async function mergeIntoCompany(
  brand: BrandLike,
  result: MatchResult,
  deps: MigrationDeps,
  summary: MigrationSummary
): Promise<BrandMapping> {
  const company = result.company;
  if (!company) {
    // unreachable — caller only invokes mergeIntoCompany on domain/name-fuzzy
    return { brand, companyId: null, decision: "ambiguous" };
  }
  const score = result.score ?? 1;
  const decision: "merged-domain" | "merged-name-fuzzy" =
    result.kind === "domain" ? "merged-domain" : "merged-name-fuzzy";

  const brandFields = extractBrandFields(brand.metadata);
  const merge = mergeBrandIntoCompany(company.metadata, brandFields);

  // Back-fill `primary_domain` from the brand when the company doesn't
  // have one yet — important for fuzzy matches where the company hasn't
  // declared a domain. Future runs will then match by domain.
  const brandDomain = canonicalizeDomain(
    pickDomainFromMetadata(brand.metadata)
  );
  if (brandDomain && typeof merge.metadata.primary_domain !== "string") {
    merge.metadata.primary_domain = brandDomain;
    merge.changed = true;
    merge.filledFields.push("primary_domain");
  }

  if (!merge.changed) {
    summary.noop++;
    deps.audit.record({
      decision: "noop",
      brand_id: brand.id,
      brand_name: brand.name,
      ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
      company_id: company.id,
      company_name: company.name,
      ...(company.slug !== undefined ? { company_slug: company.slug } : {}),
      score,
      reason: "all brand fields already populated on company",
    });
    return { brand, companyId: company.id, decision: "merge-noop" };
  }

  if (deps.apply) {
    try {
      await deps.target.updateEntity({
        entity_id: company.id,
        metadata: merge.metadata,
      });
      // Reflect the write into the in-memory candidate list so re-running
      // inside the same process treats this brand idempotently.
      company.metadata = merge.metadata;
    } catch (err) {
      deps.audit.record({
        decision: "merge-failed",
        brand_id: brand.id,
        brand_name: brand.name,
        ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
        company_id: company.id,
        reason: `updateEntity failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      summary.ambiguous++;
      // Return companyId=null so the mention re-target pass treats this
      // brand as unresolved and leaves its mentions in place. Otherwise
      // we'd silently re-point mentions at a company we couldn't actually
      // merge into.
      return { brand, companyId: null, decision: "ambiguous" };
    }
  }

  if (decision === "merged-domain") summary.mergedDomain++;
  else summary.mergedFuzzy++;

  deps.audit.record({
    decision,
    brand_id: brand.id,
    brand_name: brand.name,
    ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
    company_id: company.id,
    company_name: company.name,
    ...(company.slug !== undefined ? { company_slug: company.slug } : {}),
    score,
    reason: `filled ${merge.filledFields.join(", ") || "(no fields)"}`,
  });

  return {
    brand,
    companyId: company.id,
    decision: decision === "merged-domain" ? "merged-domain" : "merged-fuzzy",
  };
}

async function createCompanyFromBrand(
  brand: BrandLike,
  companies: CompanyCandidate[],
  deps: MigrationDeps,
  summary: MigrationSummary,
  bestFuzzyScore?: number
): Promise<BrandMapping> {
  const brandFields = extractBrandFields(brand.metadata);
  const metadata = brandToNewCompanyMetadata(brandFields);

  // Carry the canonical domain forward if MI had one, so future runs match
  // by domain. Store the canonicalized form so the next run's domain lookup
  // hits regardless of how the original raw value was formatted.
  const rawDomain = pickDomainFromMetadata(brand.metadata);
  const canonicalDomain = canonicalizeDomain(rawDomain);
  if (canonicalDomain && !metadata.primary_domain) {
    metadata.primary_domain = canonicalDomain;
  }

  let companyId: number | null = null;
  if (deps.apply) {
    try {
      const created = await deps.target.createEntity({
        entity_type: "company",
        name: brand.name,
        slug: brand.slug,
        metadata,
      });
      companyId = created.id;
      // Add to the in-memory company list so a subsequent brand sharing
      // this domain / name in the same run merges into it instead of
      // creating a duplicate.
      companies.push({
        id: created.id,
        name: created.name,
        ...(created.slug !== undefined ? { slug: created.slug } : {}),
        metadata,
      });
    } catch (err) {
      deps.audit.record({
        decision: "create-failed",
        brand_id: brand.id,
        brand_name: brand.name,
        ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
        reason: `createEntity failed (likely slug collision); skipping: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      // Counted as ambiguous in the summary so operators see one bucket
      // for "needs manual review".
      summary.ambiguous++;
      return { brand, companyId: null, decision: "ambiguous" };
    }
  } else {
    // Dry-run: still add to the in-memory list so the same run's
    // *subsequent* brands don't propose a second create against the
    // same domain. Use a sentinel id below 0 so audit / mention-retarget
    // treats it as "would create" rather than as a real persisted id.
    nextDryRunId -= 1;
    companyId = nextDryRunId;
    companies.push({
      id: companyId,
      name: brand.name,
      ...(brand.slug !== undefined ? { slug: brand.slug } : {}),
      metadata,
    });
  }

  summary.created++;
  const reasonSuffix =
    bestFuzzyScore !== undefined && bestFuzzyScore > 0
      ? ` (best fuzzy score ${bestFuzzyScore.toFixed(3)} < threshold ${deps.threshold})`
      : "";
  deps.audit.record({
    decision: "created",
    brand_id: brand.id,
    brand_name: brand.name,
    ...(brand.slug !== undefined ? { brand_slug: brand.slug } : {}),
    ...(companyId !== null ? { company_id: companyId } : {}),
    company_name: brand.name,
    ...(brand.slug !== undefined ? { company_slug: brand.slug } : {}),
    ...(bestFuzzyScore !== undefined ? { score: bestFuzzyScore } : {}),
    reason: deps.apply
      ? `no match — created new market.company${reasonSuffix}`
      : `no match — would create new market.company${reasonSuffix}`,
  });

  return { brand, companyId, decision: "created" };
}

// ── Mention re-target ───────────────────────────────────────────────────

async function retargetMentions(
  brandToCompany: Map<number, number | null>,
  deps: MigrationDeps,
  summary: MigrationSummary
): Promise<void> {
  deps.log("");
  deps.log("re-targeting market-intelligence mentions relationships");

  // For every brand we processed, list its mentions links on the source
  // org and re-create them in the target org pointing at the matched
  // company. We only handle mentions that touch a brand we actually
  // merged or created; unresolved (ambiguous / below-threshold) brands
  // leave their mentions in place and we tag them in the audit log.
  for (const [brandId, companyId] of brandToCompany) {
    let links: Awaited<ReturnType<OrgClient["listLinks"]>>;
    try {
      links = await deps.source.listLinks({
        entity_id: brandId,
        relationship_type_slug: "mentions",
      });
    } catch (err) {
      deps.log(
        `[error] listing mentions for brand ${brandId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    for (const link of links) {
      if (companyId === null) {
        summary.mentionsSkipped++;
        deps.audit.record({
          decision: "mention-skipped",
          brand_id: brandId,
          mention_id: link.id,
          reason:
            "source brand was ambiguous / unmatched; mention left in place",
        });
        continue;
      }

      // Sentinel id (< 0) means "we would create this company in apply
      // mode but no real id exists yet". Audit-log + move on.
      if (companyId < 0) {
        summary.mentionsRetargeted++;
        deps.audit.record({
          decision: "mention-retargeted",
          brand_id: brandId,
          mention_id: link.id,
          company_id: companyId,
          reason: "would re-target after creating new market.company (dry-run)",
        });
        continue;
      }

      // Decide which side of the link the brand is on. The "other" side
      // becomes our new from/to in the target org. If the other side
      // isn't a market entity, we can't follow it across — log + skip.
      const brandIsFrom = link.from_entity_id === brandId;
      const otherEntityId = brandIsFrom
        ? link.to_entity_id
        : link.from_entity_id;

      // The other entity also needs to live in the target org. In
      // practice the MI mentions schema points brand → some content
      // entity; that content side has to exist in market for us to
      // re-target the link. For the migration's first pass we leave
      // those un-mapped — they belong to a later pass that mirrors
      // MI content into market.
      let otherInTarget: { id: number } | null;
      try {
        otherInTarget = await tryGetEntity(deps.target, otherEntityId);
      } catch (err) {
        summary.mentionsSkipped++;
        deps.audit.record({
          decision: "mention-skipped",
          brand_id: brandId,
          mention_id: link.id,
          company_id: companyId,
          reason: `lookup of ${otherEntityId} on ${deps.target.orgSlug} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      if (!otherInTarget) {
        summary.mentionsSkipped++;
        deps.audit.record({
          decision: "mention-skipped",
          brand_id: brandId,
          mention_id: link.id,
          company_id: companyId,
          reason: `other side ${otherEntityId} has no counterpart in ${deps.target.orgSlug}`,
        });
        continue;
      }

      const newFrom = brandIsFrom ? companyId : otherInTarget.id;
      const newTo = brandIsFrom ? otherInTarget.id : companyId;

      // Dedup against existing identical links — re-runs must converge.
      // We list every mentions link on the company side (paginated under
      // the hood) and check for a matching counterpart.
      let alreadyLinked = false;
      try {
        const existing = await deps.target.listLinks({
          entity_id: companyId,
          relationship_type_slug: "mentions",
        });
        alreadyLinked = existing.some(
          (l) => l.from_entity_id === newFrom && l.to_entity_id === newTo
        );
      } catch {
        // If listing fails (e.g. transient), fall through and let createLink
        // surface the error.
      }

      if (alreadyLinked) {
        summary.mentionsRetargeted++;
        deps.audit.record({
          decision: "mention-retargeted",
          brand_id: brandId,
          mention_id: link.id,
          company_id: companyId,
          reason: "target already has equivalent mentions link (noop)",
        });
        continue;
      }

      if (deps.apply) {
        try {
          await deps.target.createLink({
            from_entity_id: newFrom,
            to_entity_id: newTo,
            relationship_type_slug: "mentions",
            metadata: link.metadata ?? undefined,
            ...(link.confidence !== undefined
              ? { confidence: link.confidence }
              : {}),
            // Preserve the original relationship source when it's one of
            // the typed options; default to `api` when unknown / absent.
            source:
              link.source === "ui" ||
              link.source === "llm" ||
              link.source === "feed" ||
              link.source === "api"
                ? link.source
                : "api",
          });
        } catch (err) {
          summary.mentionsSkipped++;
          deps.audit.record({
            decision: "mention-skipped",
            brand_id: brandId,
            mention_id: link.id,
            company_id: companyId,
            reason: `createLink failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          continue;
        }
      }

      summary.mentionsRetargeted++;
      deps.audit.record({
        decision: "mention-retargeted",
        brand_id: brandId,
        mention_id: link.id,
        company_id: companyId,
      });
    }
  }
}

async function tryGetEntity(
  client: OrgClient,
  entity_id: number
): Promise<{ id: number } | null> {
  try {
    const ent = await client.getEntity(entity_id);
    return ent ? { id: ent.id } : null;
  } catch {
    return null;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────

export async function main(
  argv: string[] = process.argv.slice(2)
): Promise<void> {
  const args: RootArgs = parseRootArgs(argv);
  const log = makeLogger("mi-migrate");
  log(
    `mode=${args.apply ? "APPLY (live writes)" : "dry-run"} ` +
      `match-only=${args.matchOnly} threshold=${args.threshold} ` +
      `source=${args.sourceOrg} target=${args.targetOrg}`
  );

  const audit = createAuditLog({ dryRun: !args.apply });
  log(`audit log → ${audit.path}`);

  const source = createHttpOrgClient({ orgSlug: args.sourceOrg });
  const target = createHttpOrgClient({ orgSlug: args.targetOrg });

  await runMigration({
    source,
    target,
    audit,
    apply: args.apply,
    threshold: args.threshold,
    matchOnly: args.matchOnly,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    log,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
