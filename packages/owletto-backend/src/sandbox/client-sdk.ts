/**
 * ClientSDK — one in-process SDK shared by the `execute` MCP tool (PR-2) and
 * watcher reactions (PR-2 swap). Each namespace delegates to existing tool
 * handlers, preserving per-call auth checks and audit/change events.
 *
 * Multi-org support is provided by `client.org(slugOrId)`: it re-validates
 * membership against the `member` table, then returns a proxy SDK bound to a
 * swapped `ToolContext`. Membership lookups are cached in a small LRU with a
 * short TTL so a cross-org walk doesn't hammer Postgres, while still catching
 * revocations within ~30 s.
 */

import { getDb } from "../db/client";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";
import { getWorkspaceProvider } from "../workspace";
import type { OrgInfo } from "../workspace/types";
import { MembershipCache, type MembershipRecord } from "./membership-cache";
import {
  buildAuthProfilesNamespace,
  buildClassifiersNamespace,
  buildConnectionsNamespace,
  buildEntitiesNamespace,
  buildEntitySchemaNamespace,
  buildFeedsNamespace,
  buildKnowledgeNamespace,
  buildOperationsNamespace,
  buildOrganizationsNamespace,
  buildViewTemplatesNamespace,
  buildWatchersNamespace,
} from "./namespaces";
import type { AuthProfilesNamespace } from "./namespaces/auth-profiles";
import type { ClassifiersNamespace } from "./namespaces/classifiers";
import type { ConnectionsNamespace } from "./namespaces/connections";
import type { EntitiesNamespace } from "./namespaces/entities";
import type { EntitySchemaNamespace } from "./namespaces/entity-schema";
import type { FeedsNamespace } from "./namespaces/feeds";
import type { KnowledgeNamespace } from "./namespaces/knowledge";
import type { OperationsNamespace } from "./namespaces/operations";
import type { OrganizationsNamespace } from "./namespaces/organizations";
import type { ViewTemplatesNamespace } from "./namespaces/view-templates";
import type { WatchersNamespace } from "./namespaces/watchers";

export interface ClientSDK {
  entities: EntitiesNamespace;
  entitySchema: EntitySchemaNamespace;
  connections: ConnectionsNamespace;
  feeds: FeedsNamespace;
  authProfiles: AuthProfilesNamespace;
  operations: OperationsNamespace;
  watchers: WatchersNamespace;
  classifiers: ClassifiersNamespace;
  viewTemplates: ViewTemplatesNamespace;
  knowledge: KnowledgeNamespace;
  organizations: OrganizationsNamespace;

  /**
   * Return a ClientSDK bound to a different organization the caller belongs
   * to. Re-validates membership on each call; throws `AccessDenied` for
   * private orgs the caller isn't a member of.
   *
   * Public-visibility orgs return an SDK with `memberRole: null` — reads
   * succeed, writes fail at the handler-level access check.
   *
   * The returned SDK is fully independent: it has its own `.org()` that still
   * resolves relative to the original user, so chains like
   * `client.org('a').org('b')` are legal if the user is a member of both.
   */
  org(slugOrId: string): Promise<ClientSDK>;

  /** Run a read-only SQL query scoped to the current organization. */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;

  /** Emit a structured log entry (captured by the invocation audit row in PR-3). */
  log(message: string, data?: Record<string, unknown>): void;
}

export interface BuildClientSDKOptions {
  /** Pre-seeded membership cache shared across `.org()` calls in one isolate run. */
  membershipCache?: MembershipCache;
}

// Re-export so callers can `import { MembershipCache } from '../sandbox/client-sdk'`
// if they prefer; new code should import from `./membership-cache` directly.
export { MembershipCache } from "./membership-cache";
export type { MembershipRecord } from "./membership-cache";

// ---------------------------------------------------------------------------
// Membership resolution
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Better Auth emits org IDs as text (not UUIDs) — we accept both UUIDs and
// opaque ID strings as "id-shaped" when they don't match a slug pattern.
const ID_RE = /^[A-Za-z0-9_-]{20,}$/;

export class AccessDeniedError extends Error {
  code = "AccessDenied" as const;
  constructor(message: string) {
    super(message);
    this.name = "AccessDenied";
  }
}

export class OrgNotFoundError extends Error {
  code = "OrgNotFound" as const;
  constructor(message: string) {
    super(message);
    this.name = "OrgNotFound";
  }
}

/**
 * Resolve an org identifier (slug or id) into a membership record, checking
 * the caller's access. Throws `OrgNotFound` if the org doesn't exist and
 * `AccessDenied` if the caller has no read access (non-member on a private
 * org).
 */
export async function resolveOrgMembership(
  slugOrId: string,
  ctx: ToolContext,
  cache: MembershipCache
): Promise<MembershipRecord> {
  const cached = cache.get(ctx.userId, slugOrId);
  if (cached) {
    if (cached.visibility === "private" && cached.role === null) {
      throw new AccessDeniedError(
        `You are not a member of organization '${slugOrId}'.`
      );
    }
    return cached;
  }

  const sql = getDb();
  const looksLikeId = UUID_RE.test(slugOrId) || ID_RE.test(slugOrId);
  const lookup = looksLikeId
    ? await sql`SELECT id, slug, visibility FROM "organization" WHERE id = ${slugOrId} LIMIT 1`
    : await sql`SELECT id, slug, visibility FROM "organization" WHERE slug = ${slugOrId} LIMIT 1`;

  if (lookup.length === 0) {
    throw new OrgNotFoundError(`Organization '${slugOrId}' not found.`);
  }
  const row = lookup[0] as {
    id: string;
    slug: string;
    visibility: "public" | "private" | string;
  };
  const visibility = row.visibility === "public" ? "public" : "private";

  let role: string | null = null;
  if (ctx.userId) {
    const memberRows = await sql`
      SELECT role FROM "member"
      WHERE "organizationId" = ${row.id} AND "userId" = ${ctx.userId}
      LIMIT 1
    `;
    role = memberRows.length > 0 ? (memberRows[0].role as string) : null;
  }

  const record: MembershipRecord = {
    orgId: row.id,
    slug: row.slug,
    role,
    visibility,
    expiresAt: 0, // set by cache
  };
  // Cache under both slug and id to avoid duplicate resolutions within the TTL.
  cache.set(ctx.userId, [row.id, row.slug], record);

  if (visibility === "private" && role === null) {
    throw new AccessDeniedError(
      `You are not a member of organization '${slugOrId}'.`
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// SDK construction
// ---------------------------------------------------------------------------

/**
 * Build a `ClientSDK` bound to the caller's current `ToolContext`. The SDK
 * exposes `.org()` which constructs a fresh `ClientSDK` after re-validating
 * membership against the shared `MembershipCache`.
 */
export function buildClientSDK(
  ctx: ToolContext,
  env: Env,
  options: BuildClientSDKOptions = {}
): ClientSDK {
  const cache = options.membershipCache ?? new MembershipCache();

  const sdk: ClientSDK = {
    entities: buildEntitiesNamespace(ctx, env),
    entitySchema: buildEntitySchemaNamespace(ctx, env),
    connections: buildConnectionsNamespace(ctx, env),
    feeds: buildFeedsNamespace(ctx, env),
    authProfiles: buildAuthProfilesNamespace(ctx, env),
    operations: buildOperationsNamespace(ctx, env),
    watchers: buildWatchersNamespace(ctx, env),
    classifiers: buildClassifiersNamespace(ctx, env),
    viewTemplates: buildViewTemplatesNamespace(ctx, env),
    knowledge: buildKnowledgeNamespace(ctx, env),
    organizations: buildOrganizationsNamespace(ctx, env),

    async org(slugOrId) {
      const member = await resolveOrgMembership(slugOrId, ctx, cache);
      const swapped: ToolContext = {
        ...ctx,
        organizationId: member.orgId,
        memberRole: member.role,
      };
      return buildClientSDK(swapped, env, { membershipCache: cache });
    },

    async query(querySql, params) {
      const { validateAndScopeQuery } = await import(
        "../utils/execute-data-sources"
      );
      const scoped = validateAndScopeQuery(querySql, ctx.organizationId);
      const db = getDb();
      const rows = await db.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx.unsafe("SET LOCAL statement_timeout = '5000'");
        const merged = (scoped.params as unknown[]).concat(params ?? []);
        return tx.unsafe(scoped.sql, merged);
      });
      return rows.map((r: Record<string, unknown>) => ({ ...r }));
    },

    log(message, data) {
      // Structured log; PR-3 routes these into the execute_invocation audit row.
      // eslint-disable-next-line no-console
      console.log(`[client-sdk] ${message}`, data ?? {});
    },
  };

  return sdk;
}

/**
 * Convenience: look up `OrgInfo` for the caller's current org. Useful for the
 * `search` tool's preamble and the web console's header chip.
 */
export async function getCurrentOrgInfo(
  ctx: ToolContext
): Promise<OrgInfo | null> {
  const provider = getWorkspaceProvider();
  const orgs = await provider.listOrganizations(undefined, ctx.userId);
  return orgs.find((o) => o.id === ctx.organizationId) ?? null;
}
