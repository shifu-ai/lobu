/**
 * scripts/seed-atlas/index.ts
 *
 * Top-level entrypoint for the Atlas seeders.
 *
 * Usage:
 *   bun run scripts/seed-atlas/index.ts                    # all, against live API
 *   bun run scripts/seed-atlas/index.ts --dry-run          # log payloads, no calls
 *   bun run scripts/seed-atlas/index.ts --limit=5          # cap rows per type
 *   bun run scripts/seed-atlas/index.ts --only=countries,cities
 *
 * Environment:
 *   OWLETTO_BASE_URL    e.g. https://owletto.example.com
 *   OWLETTO_API_TOKEN   PAT or OAuth bearer with write access to the atlas org
 *   ATLAS_RATE_LIMIT    optional, requests/sec ceiling (default: 50)
 *
 * Topological order: countries → regions → cities → industries → technologies
 * → universities. Cross-entity FKs (region→country, city→country/region,
 * university→country) are resolved by reading the live API at the start of
 * each downstream seeder, so each pass is fully idempotent on its own.
 */

import {
  createHttpAtlasClient,
  makeLogger,
  parseRootArgs,
  type SeederContext,
  type SeederOptions,
} from "./lib.ts";
import { seedCountries } from "./countries.ts";
import { seedRegions } from "./regions.ts";
import { seedCities } from "./cities.ts";
import { seedIndustries } from "./industries.ts";
import { seedTechnologies } from "./technologies.ts";
import { seedUniversities } from "./universities.ts";

interface SeederStep {
  name: string;
  run: (ctx: SeederContext) => Promise<void>;
}

const STEPS: readonly SeederStep[] = Object.freeze([
  { name: "countries", run: seedCountries },
  { name: "regions", run: seedRegions },
  { name: "cities", run: seedCities },
  { name: "industries", run: seedIndustries },
  { name: "technologies", run: seedTechnologies },
  { name: "universities", run: seedUniversities },
]);

export async function main(
  argv: string[] = process.argv.slice(2)
): Promise<void> {
  const args = parseRootArgs(argv);
  const log = makeLogger("seed-atlas");

  const rateLimitPerSec =
    Number.parseInt(process.env.ATLAS_RATE_LIMIT ?? "50", 10) || 50;
  const options: SeederOptions = {
    dryRun: args.dryRun,
    rateLimitPerSec,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
  const client = args.dryRun ? null : createHttpAtlasClient();

  const targets = STEPS.filter(
    (step) => !args.only || args.only.has(step.name)
  );
  if (targets.length === 0) {
    log(`no seeder matched --only=${[...(args.only ?? [])].join(",")}`);
    return;
  }

  log(
    `running ${targets.map((t) => t.name).join(", ")} (dry-run=${args.dryRun})`
  );

  for (const step of targets) {
    log(`▶ ${step.name}`);
    try {
      await step.run({ client, options, log: makeLogger(step.name) });
      log(`✔ ${step.name}`);
    } catch (err) {
      log(
        `✘ ${step.name}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Don't abort the run — record + continue. Later seeders will simply
      // see fewer FK resolutions, which is the same as missing seed data.
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
