/**
 * scripts/seed-atlas/technologies.ts
 *
 * Seeds atlas.technology with a curated starter list (~200 entries across
 * languages, frameworks, databases, devops, observability, AI/ML, cloud).
 *
 * Curated, not scraped — Wikipedia / StackShare / similar sources are
 * either license-encumbered or churn faster than makes sense for a
 * canonical reference. This list is the seed; subsequent additions are
 * the operator's call (or a downstream agent's).
 *
 * Canonical key: entity.slug (lowercase, hyphenated form of name). The
 * tech YAML only declares `category` + `homepage_url` in metadata; we
 * don't smuggle a slug into metadata to avoid schema drift.
 */

import {
  createHttpAtlasClient,
  loadAtlasEntityType,
  makeLogger,
  parseRootArgs,
  type SeederContext,
  type UpsertSpec,
  upsertEntities,
  validateMetadataAgainstSchema,
} from "./lib.ts";

export interface TechnologyRow {
  name: string;
  category: string;
  homepage_url?: string;
}

// ── Curated list ────────────────────────────────────────────────────────

export const TECHNOLOGIES: readonly TechnologyRow[] = Object.freeze([
  // Languages
  {
    name: "JavaScript",
    category: "language",
    homepage_url: "https://developer.mozilla.org/docs/Web/JavaScript",
  },
  {
    name: "TypeScript",
    category: "language",
    homepage_url: "https://www.typescriptlang.org",
  },
  {
    name: "Python",
    category: "language",
    homepage_url: "https://www.python.org",
  },
  { name: "Go", category: "language", homepage_url: "https://go.dev" },
  {
    name: "Rust",
    category: "language",
    homepage_url: "https://www.rust-lang.org",
  },
  {
    name: "Java",
    category: "language",
    homepage_url: "https://www.oracle.com/java",
  },
  {
    name: "Kotlin",
    category: "language",
    homepage_url: "https://kotlinlang.org",
  },
  { name: "Swift", category: "language", homepage_url: "https://swift.org" },
  { name: "C", category: "language" },
  { name: "C++", category: "language" },
  {
    name: "C#",
    category: "language",
    homepage_url: "https://learn.microsoft.com/dotnet/csharp",
  },
  {
    name: "Ruby",
    category: "language",
    homepage_url: "https://www.ruby-lang.org",
  },
  { name: "PHP", category: "language", homepage_url: "https://www.php.net" },
  {
    name: "Elixir",
    category: "language",
    homepage_url: "https://elixir-lang.org",
  },
  {
    name: "Erlang",
    category: "language",
    homepage_url: "https://www.erlang.org",
  },
  {
    name: "Scala",
    category: "language",
    homepage_url: "https://www.scala-lang.org",
  },
  {
    name: "Clojure",
    category: "language",
    homepage_url: "https://clojure.org",
  },
  {
    name: "Haskell",
    category: "language",
    homepage_url: "https://www.haskell.org",
  },
  { name: "OCaml", category: "language", homepage_url: "https://ocaml.org" },
  { name: "F#", category: "language", homepage_url: "https://fsharp.org" },
  { name: "Lua", category: "language", homepage_url: "https://www.lua.org" },
  { name: "Dart", category: "language", homepage_url: "https://dart.dev" },
  { name: "Perl", category: "language", homepage_url: "https://www.perl.org" },
  { name: "Bash", category: "language" },
  { name: "SQL", category: "language" },
  {
    name: "R",
    category: "language",
    homepage_url: "https://www.r-project.org",
  },
  {
    name: "Julia",
    category: "language",
    homepage_url: "https://julialang.org",
  },
  { name: "Zig", category: "language", homepage_url: "https://ziglang.org" },
  { name: "Nim", category: "language", homepage_url: "https://nim-lang.org" },
  {
    name: "Crystal",
    category: "language",
    homepage_url: "https://crystal-lang.org",
  },
  {
    name: "Solidity",
    category: "language",
    homepage_url: "https://soliditylang.org",
  },
  // Frontend
  {
    name: "React",
    category: "frontend-framework",
    homepage_url: "https://react.dev",
  },
  {
    name: "Vue.js",
    category: "frontend-framework",
    homepage_url: "https://vuejs.org",
  },
  {
    name: "Angular",
    category: "frontend-framework",
    homepage_url: "https://angular.io",
  },
  {
    name: "Svelte",
    category: "frontend-framework",
    homepage_url: "https://svelte.dev",
  },
  {
    name: "SolidJS",
    category: "frontend-framework",
    homepage_url: "https://www.solidjs.com",
  },
  {
    name: "Preact",
    category: "frontend-framework",
    homepage_url: "https://preactjs.com",
  },
  {
    name: "Lit",
    category: "frontend-framework",
    homepage_url: "https://lit.dev",
  },
  {
    name: "Alpine.js",
    category: "frontend-framework",
    homepage_url: "https://alpinejs.dev",
  },
  {
    name: "Next.js",
    category: "frontend-framework",
    homepage_url: "https://nextjs.org",
  },
  {
    name: "Nuxt",
    category: "frontend-framework",
    homepage_url: "https://nuxt.com",
  },
  {
    name: "Remix",
    category: "frontend-framework",
    homepage_url: "https://remix.run",
  },
  {
    name: "Astro",
    category: "frontend-framework",
    homepage_url: "https://astro.build",
  },
  {
    name: "SvelteKit",
    category: "frontend-framework",
    homepage_url: "https://kit.svelte.dev",
  },
  {
    name: "Tailwind CSS",
    category: "css",
    homepage_url: "https://tailwindcss.com",
  },
  { name: "Sass", category: "css", homepage_url: "https://sass-lang.com" },
  { name: "Less", category: "css", homepage_url: "https://lesscss.org" },
  { name: "styled-components", category: "css" },
  { name: "Emotion", category: "css" },
  // Backend
  { name: "Node.js", category: "runtime", homepage_url: "https://nodejs.org" },
  { name: "Deno", category: "runtime", homepage_url: "https://deno.land" },
  { name: "Bun", category: "runtime", homepage_url: "https://bun.sh" },
  {
    name: "Express",
    category: "backend-framework",
    homepage_url: "https://expressjs.com",
  },
  {
    name: "Fastify",
    category: "backend-framework",
    homepage_url: "https://fastify.dev",
  },
  {
    name: "Hono",
    category: "backend-framework",
    homepage_url: "https://hono.dev",
  },
  {
    name: "Koa",
    category: "backend-framework",
    homepage_url: "https://koajs.com",
  },
  {
    name: "NestJS",
    category: "backend-framework",
    homepage_url: "https://nestjs.com",
  },
  {
    name: "Django",
    category: "backend-framework",
    homepage_url: "https://www.djangoproject.com",
  },
  {
    name: "Flask",
    category: "backend-framework",
    homepage_url: "https://flask.palletsprojects.com",
  },
  {
    name: "FastAPI",
    category: "backend-framework",
    homepage_url: "https://fastapi.tiangolo.com",
  },
  {
    name: "Ruby on Rails",
    category: "backend-framework",
    homepage_url: "https://rubyonrails.org",
  },
  {
    name: "Laravel",
    category: "backend-framework",
    homepage_url: "https://laravel.com",
  },
  {
    name: "Symfony",
    category: "backend-framework",
    homepage_url: "https://symfony.com",
  },
  {
    name: "Spring Boot",
    category: "backend-framework",
    homepage_url: "https://spring.io/projects/spring-boot",
  },
  {
    name: "Phoenix",
    category: "backend-framework",
    homepage_url: "https://www.phoenixframework.org",
  },
  { name: "ASP.NET Core", category: "backend-framework" },
  {
    name: "Gin",
    category: "backend-framework",
    homepage_url: "https://gin-gonic.com",
  },
  {
    name: "Echo",
    category: "backend-framework",
    homepage_url: "https://echo.labstack.com",
  },
  {
    name: "Actix",
    category: "backend-framework",
    homepage_url: "https://actix.rs",
  },
  { name: "Axum", category: "backend-framework" },
  // Databases — relational
  {
    name: "PostgreSQL",
    category: "database",
    homepage_url: "https://www.postgresql.org",
  },
  {
    name: "MySQL",
    category: "database",
    homepage_url: "https://www.mysql.com",
  },
  {
    name: "MariaDB",
    category: "database",
    homepage_url: "https://mariadb.org",
  },
  {
    name: "SQLite",
    category: "database",
    homepage_url: "https://www.sqlite.org",
  },
  {
    name: "CockroachDB",
    category: "database",
    homepage_url: "https://www.cockroachlabs.com",
  },
  {
    name: "YugabyteDB",
    category: "database",
    homepage_url: "https://www.yugabyte.com",
  },
  {
    name: "TiDB",
    category: "database",
    homepage_url: "https://www.pingcap.com/tidb",
  },
  // Databases — NoSQL / KV / search / time-series / vector
  {
    name: "MongoDB",
    category: "database",
    homepage_url: "https://www.mongodb.com",
  },
  { name: "Redis", category: "database", homepage_url: "https://redis.io" },
  {
    name: "DragonflyDB",
    category: "database",
    homepage_url: "https://www.dragonflydb.io",
  },
  { name: "KeyDB", category: "database" },
  {
    name: "Memcached",
    category: "database",
    homepage_url: "https://memcached.org",
  },
  {
    name: "Cassandra",
    category: "database",
    homepage_url: "https://cassandra.apache.org",
  },
  {
    name: "ScyllaDB",
    category: "database",
    homepage_url: "https://www.scylladb.com",
  },
  { name: "DynamoDB", category: "database" },
  { name: "Firestore", category: "database" },
  {
    name: "Elasticsearch",
    category: "search",
    homepage_url: "https://www.elastic.co",
  },
  {
    name: "OpenSearch",
    category: "search",
    homepage_url: "https://opensearch.org",
  },
  {
    name: "Meilisearch",
    category: "search",
    homepage_url: "https://www.meilisearch.com",
  },
  {
    name: "Typesense",
    category: "search",
    homepage_url: "https://typesense.org",
  },
  {
    name: "Algolia",
    category: "search",
    homepage_url: "https://www.algolia.com",
  },
  {
    name: "InfluxDB",
    category: "time-series",
    homepage_url: "https://www.influxdata.com",
  },
  {
    name: "TimescaleDB",
    category: "time-series",
    homepage_url: "https://www.timescale.com",
  },
  {
    name: "QuestDB",
    category: "time-series",
    homepage_url: "https://questdb.io",
  },
  {
    name: "Pinecone",
    category: "vector-db",
    homepage_url: "https://www.pinecone.io",
  },
  {
    name: "Weaviate",
    category: "vector-db",
    homepage_url: "https://weaviate.io",
  },
  {
    name: "Qdrant",
    category: "vector-db",
    homepage_url: "https://qdrant.tech",
  },
  { name: "Milvus", category: "vector-db", homepage_url: "https://milvus.io" },
  {
    name: "Chroma",
    category: "vector-db",
    homepage_url: "https://www.trychroma.com",
  },
  { name: "Neo4j", category: "graph-db", homepage_url: "https://neo4j.com" },
  { name: "Dgraph", category: "graph-db", homepage_url: "https://dgraph.io" },
  // Streaming / queues
  {
    name: "Kafka",
    category: "streaming",
    homepage_url: "https://kafka.apache.org",
  },
  {
    name: "RabbitMQ",
    category: "queue",
    homepage_url: "https://www.rabbitmq.com",
  },
  { name: "NATS", category: "streaming", homepage_url: "https://nats.io" },
  {
    name: "Pulsar",
    category: "streaming",
    homepage_url: "https://pulsar.apache.org",
  },
  {
    name: "Redpanda",
    category: "streaming",
    homepage_url: "https://redpanda.com",
  },
  { name: "AWS SQS", category: "queue" },
  { name: "AWS SNS", category: "queue" },
  {
    name: "Temporal",
    category: "workflow",
    homepage_url: "https://temporal.io",
  },
  {
    name: "Inngest",
    category: "workflow",
    homepage_url: "https://www.inngest.com",
  },
  // DevOps / infra / containers
  {
    name: "Docker",
    category: "container",
    homepage_url: "https://www.docker.com",
  },
  { name: "Podman", category: "container", homepage_url: "https://podman.io" },
  {
    name: "Kubernetes",
    category: "orchestration",
    homepage_url: "https://kubernetes.io",
  },
  { name: "Helm", category: "orchestration", homepage_url: "https://helm.sh" },
  {
    name: "Nomad",
    category: "orchestration",
    homepage_url: "https://www.nomadproject.io",
  },
  {
    name: "Terraform",
    category: "iac",
    homepage_url: "https://www.terraform.io",
  },
  { name: "Pulumi", category: "iac", homepage_url: "https://www.pulumi.com" },
  { name: "Ansible", category: "iac", homepage_url: "https://www.ansible.com" },
  { name: "Chef", category: "iac" },
  { name: "Puppet", category: "iac" },
  { name: "Packer", category: "iac", homepage_url: "https://www.packer.io" },
  // CI / CD
  {
    name: "GitHub Actions",
    category: "ci",
    homepage_url: "https://github.com/features/actions",
  },
  { name: "GitLab CI", category: "ci" },
  { name: "CircleCI", category: "ci", homepage_url: "https://circleci.com" },
  { name: "Jenkins", category: "ci", homepage_url: "https://www.jenkins.io" },
  { name: "Buildkite", category: "ci", homepage_url: "https://buildkite.com" },
  { name: "Drone", category: "ci" },
  // Cloud providers
  { name: "AWS", category: "cloud", homepage_url: "https://aws.amazon.com" },
  {
    name: "Google Cloud",
    category: "cloud",
    homepage_url: "https://cloud.google.com",
  },
  {
    name: "Azure",
    category: "cloud",
    homepage_url: "https://azure.microsoft.com",
  },
  {
    name: "Cloudflare",
    category: "cloud",
    homepage_url: "https://www.cloudflare.com",
  },
  { name: "Vercel", category: "cloud", homepage_url: "https://vercel.com" },
  {
    name: "Netlify",
    category: "cloud",
    homepage_url: "https://www.netlify.com",
  },
  { name: "Fly.io", category: "cloud", homepage_url: "https://fly.io" },
  { name: "Railway", category: "cloud", homepage_url: "https://railway.app" },
  { name: "Render", category: "cloud", homepage_url: "https://render.com" },
  {
    name: "DigitalOcean",
    category: "cloud",
    homepage_url: "https://www.digitalocean.com",
  },
  { name: "Linode", category: "cloud" },
  {
    name: "Hetzner",
    category: "cloud",
    homepage_url: "https://www.hetzner.com",
  },
  { name: "Supabase", category: "baas", homepage_url: "https://supabase.com" },
  {
    name: "Firebase",
    category: "baas",
    homepage_url: "https://firebase.google.com",
  },
  // Observability / monitoring
  {
    name: "Prometheus",
    category: "observability",
    homepage_url: "https://prometheus.io",
  },
  {
    name: "Grafana",
    category: "observability",
    homepage_url: "https://grafana.com",
  },
  {
    name: "Datadog",
    category: "observability",
    homepage_url: "https://www.datadoghq.com",
  },
  {
    name: "New Relic",
    category: "observability",
    homepage_url: "https://newrelic.com",
  },
  {
    name: "Sentry",
    category: "observability",
    homepage_url: "https://sentry.io",
  },
  { name: "Loki", category: "observability" },
  { name: "Tempo", category: "observability" },
  { name: "Mimir", category: "observability" },
  {
    name: "OpenTelemetry",
    category: "observability",
    homepage_url: "https://opentelemetry.io",
  },
  {
    name: "Jaeger",
    category: "observability",
    homepage_url: "https://www.jaegertracing.io",
  },
  {
    name: "Honeycomb",
    category: "observability",
    homepage_url: "https://www.honeycomb.io",
  },
  {
    name: "Splunk",
    category: "observability",
    homepage_url: "https://www.splunk.com",
  },
  // Build tools / package managers
  { name: "Vite", category: "build", homepage_url: "https://vitejs.dev" },
  {
    name: "Webpack",
    category: "build",
    homepage_url: "https://webpack.js.org",
  },
  { name: "Rollup", category: "build", homepage_url: "https://rollupjs.org" },
  {
    name: "esbuild",
    category: "build",
    homepage_url: "https://esbuild.github.io",
  },
  { name: "SWC", category: "build", homepage_url: "https://swc.rs" },
  {
    name: "Turbopack",
    category: "build",
    homepage_url: "https://turbo.build/pack",
  },
  {
    name: "npm",
    category: "package-manager",
    homepage_url: "https://www.npmjs.com",
  },
  {
    name: "pnpm",
    category: "package-manager",
    homepage_url: "https://pnpm.io",
  },
  {
    name: "Yarn",
    category: "package-manager",
    homepage_url: "https://yarnpkg.com",
  },
  { name: "Cargo", category: "package-manager" },
  { name: "pip", category: "package-manager" },
  {
    name: "Poetry",
    category: "package-manager",
    homepage_url: "https://python-poetry.org",
  },
  {
    name: "Maven",
    category: "package-manager",
    homepage_url: "https://maven.apache.org",
  },
  {
    name: "Gradle",
    category: "package-manager",
    homepage_url: "https://gradle.org",
  },
  // Auth / identity
  { name: "Auth0", category: "auth", homepage_url: "https://auth0.com" },
  { name: "Clerk", category: "auth", homepage_url: "https://clerk.com" },
  { name: "WorkOS", category: "auth", homepage_url: "https://workos.com" },
  { name: "Okta", category: "auth", homepage_url: "https://www.okta.com" },
  {
    name: "Keycloak",
    category: "auth",
    homepage_url: "https://www.keycloak.org",
  },
  {
    name: "BetterAuth",
    category: "auth",
    homepage_url: "https://www.better-auth.com",
  },
  // Payments
  { name: "Stripe", category: "payments", homepage_url: "https://stripe.com" },
  {
    name: "Adyen",
    category: "payments",
    homepage_url: "https://www.adyen.com",
  },
  { name: "PayPal", category: "payments" },
  {
    name: "Lemon Squeezy",
    category: "payments",
    homepage_url: "https://www.lemonsqueezy.com",
  },
  // AI / ML
  {
    name: "PyTorch",
    category: "ml-framework",
    homepage_url: "https://pytorch.org",
  },
  {
    name: "TensorFlow",
    category: "ml-framework",
    homepage_url: "https://www.tensorflow.org",
  },
  {
    name: "JAX",
    category: "ml-framework",
    homepage_url: "https://github.com/google/jax",
  },
  {
    name: "scikit-learn",
    category: "ml-framework",
    homepage_url: "https://scikit-learn.org",
  },
  {
    name: "Hugging Face Transformers",
    category: "ml-framework",
    homepage_url: "https://huggingface.co/docs/transformers",
  },
  {
    name: "LangChain",
    category: "llm-framework",
    homepage_url: "https://www.langchain.com",
  },
  {
    name: "LlamaIndex",
    category: "llm-framework",
    homepage_url: "https://www.llamaindex.ai",
  },
  {
    name: "Anthropic Claude",
    category: "llm-api",
    homepage_url: "https://www.anthropic.com",
  },
  { name: "OpenAI", category: "llm-api", homepage_url: "https://openai.com" },
  {
    name: "Mistral AI",
    category: "llm-api",
    homepage_url: "https://mistral.ai",
  },
  { name: "Cohere", category: "llm-api", homepage_url: "https://cohere.com" },
  {
    name: "Together AI",
    category: "llm-api",
    homepage_url: "https://www.together.ai",
  },
  {
    name: "Replicate",
    category: "llm-api",
    homepage_url: "https://replicate.com",
  },
  {
    name: "Ollama",
    category: "llm-runtime",
    homepage_url: "https://ollama.com",
  },
  { name: "vLLM", category: "llm-runtime" },
  { name: "llama.cpp", category: "llm-runtime" },
  // Mobile
  {
    name: "React Native",
    category: "mobile",
    homepage_url: "https://reactnative.dev",
  },
  { name: "Flutter", category: "mobile", homepage_url: "https://flutter.dev" },
  { name: "Expo", category: "mobile", homepage_url: "https://expo.dev" },
  {
    name: "Ionic",
    category: "mobile",
    homepage_url: "https://ionicframework.com",
  },
  // Testing
  { name: "Jest", category: "testing", homepage_url: "https://jestjs.io" },
  { name: "Vitest", category: "testing", homepage_url: "https://vitest.dev" },
  { name: "Mocha", category: "testing", homepage_url: "https://mochajs.org" },
  {
    name: "Playwright",
    category: "testing",
    homepage_url: "https://playwright.dev",
  },
  {
    name: "Cypress",
    category: "testing",
    homepage_url: "https://www.cypress.io",
  },
  {
    name: "Selenium",
    category: "testing",
    homepage_url: "https://www.selenium.dev",
  },
  { name: "pytest", category: "testing", homepage_url: "https://pytest.org" },
  { name: "JUnit", category: "testing" },
  // Version control / collaboration
  { name: "Git", category: "vcs", homepage_url: "https://git-scm.com" },
  { name: "GitHub", category: "vcs", homepage_url: "https://github.com" },
  { name: "GitLab", category: "vcs", homepage_url: "https://gitlab.com" },
  { name: "Bitbucket", category: "vcs" },
  { name: "Mercurial", category: "vcs" },
  // ORM / data access
  { name: "Prisma", category: "orm", homepage_url: "https://www.prisma.io" },
  {
    name: "Drizzle",
    category: "orm",
    homepage_url: "https://orm.drizzle.team",
  },
  { name: "TypeORM", category: "orm", homepage_url: "https://typeorm.io" },
  { name: "Sequelize", category: "orm", homepage_url: "https://sequelize.org" },
  {
    name: "SQLAlchemy",
    category: "orm",
    homepage_url: "https://www.sqlalchemy.org",
  },
  { name: "Hibernate", category: "orm" },
  { name: "Active Record", category: "orm" },
]);

export function slugifyTechnology(name: string): string {
  return name
    .toLowerCase()
    .replace(/\+\+/g, "pp")
    .replace(/#/g, "sharp")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTechnologySpec(row: TechnologyRow): UpsertSpec {
  const slug = slugifyTechnology(row.name);
  const metadata: Record<string, unknown> = {
    category: row.category,
  };
  if (row.homepage_url) metadata.homepage_url = row.homepage_url;
  return {
    entityType: "technology",
    name: row.name,
    slug,
    canonicalKey: slug,
    canonicalKeyField: "slug",
    metadata,
  };
}

export async function seedTechnologies(ctx: SeederContext): Promise<void> {
  const log = makeLogger("technologies");
  const schema = loadAtlasEntityType("technology");

  const specs = TECHNOLOGIES.map(buildTechnologySpec);
  log(`built ${specs.length} technology specs`);

  if (specs.length > 0) {
    const errs = validateMetadataAgainstSchema(
      schema,
      (specs[0] as UpsertSpec).metadata
    );
    if (errs.length > 0) {
      throw new Error(
        `technology payload mismatches technology.yaml: ${errs.join("; ")}`
      );
    }
  }

  const summary = await upsertEntities(ctx, "technology", specs, "slug");
  log("summary", summary);
}

if (import.meta.main) {
  const args = parseRootArgs(process.argv.slice(2));
  const client = args.dryRun ? null : createHttpAtlasClient();
  seedTechnologies({
    client,
    options: { dryRun: args.dryRun, limit: args.limit },
    log: makeLogger("technologies"),
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
