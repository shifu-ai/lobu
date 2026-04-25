/**
 * ClientSDK — one in-process SDK shared by the `execute` MCP tool (PR-2) and
 * watcher reactions (PR-2 swap). Each namespace delegates to existing tool
 * handlers, preserving per-call auth checks and audit/change events.
 *
 * Multi-org support is provided by `client.org(slugOrId)`: it resolves the
 * identifier (slug preferred, id fallback) via the auth layer's existing
 * caches (see `workspace/multi-tenant.ts`), re-reads the caller's role on
 * every call, and returns a proxy SDK bound to a swapped `ToolContext`.
 *
 * No separate LRU lives here — `MultiTenantProvider.memberRoleCache` is the
 * single source of truth, which means explicit invalidations from member-write
 * paths flow through to sandbox callers without extra plumbing.
 */

import { hasRequiredMcpScope } from "../auth/tool-access";
import type { Env } from "../index";
import type { ToolContext } from "../tools/registry";
import {
  getCachedMembershipRole,
  getCachedOrgBySlug,
  getOrgById,
} from "../workspace/multi-tenant";
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
   * to. Resolves `slugOrId` against the organization table (slug first, id
   * fallback), then re-reads the caller's role from `member` via the shared
   * `memberRoleCache`. Throws `AccessDenied` for private orgs the caller isn't
   * a member of.
   *
   * Public-visibility orgs return an SDK with `memberRole: null` — reads
   * succeed, writes fail at the handler-level access check.
   *
   * Chained hops like `client.org('a').org('b')` are legal when the caller is
   * a member of both; each hop re-validates against the original user.
   */
  org(slugOrId: string): Promise<ClientSDK>;

  /**
   * Run a read-only SQL query scoped to the current organization. User-side
   * positional parameters are not supported (`validateAndScopeQuery` rejects
   * `$N`); pass values via Handlebars `{{query.name}}` substitutions instead.
   */
  query(sql: string): Promise<unknown[]>;

  /** Emit a structured log entry (captured by the invocation audit row in PR-3). */
  log(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SdkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

export class AccessDeniedError extends SdkError {
  constructor(message: string) {
    super("AccessDenied", message);
  }
}

export class OrgNotFoundError extends SdkError {
  constructor(message: string) {
    super("OrgNotFound", message);
  }
}

// ---------------------------------------------------------------------------
// Membership resolution
// ---------------------------------------------------------------------------

export interface ResolvedOrgMembership {
  orgId: string;
  slug: string;
  role: string | null;
  visibility: "public" | "private";
}

/**
 * Resolve an org identifier (slug or id) into a membership record. Slug is
 * tried first (covers the common case and hits the auth-layer cache); on miss,
 * the id path runs. Throws `OrgNotFound` if neither matches, `AccessDenied` if
 * the caller has no read access (non-member on a private org).
 */
export async function resolveOrgMembership(
  slugOrId: string,
  ctx: ToolContext,
): Promise<ResolvedOrgMembership> {
  let orgId: string;
  let slug: string;
  let visibility: "public" | "private";

  const bySlug = await getCachedOrgBySlug(slugOrId);
  if (bySlug) {
    orgId = bySlug.id;
    slug = slugOrId;
    visibility = bySlug.visibility === "public" ? "public" : "private";
  } else {
    const byId = await getOrgById(slugOrId);
    if (!byId) {
      throw new OrgNotFoundError(`Organization '${slugOrId}' not found.`);
    }
    orgId = slugOrId;
    slug = byId.slug;
    visibility = byId.visibility === "public" ? "public" : "private";
  }

  const role = await getCachedMembershipRole(orgId, ctx.userId);

  if (visibility === "private" && role === null) {
    throw new AccessDeniedError(
      `You are not a member of organization '${slug}'.`,
    );
  }

  return { orgId, slug, role, visibility };
}

// ---------------------------------------------------------------------------
// SDK construction
// ---------------------------------------------------------------------------

function isSystemContext(ctx: ToolContext): boolean {
  return ctx.isAuthenticated === true && ctx.userId === null && ctx.memberRole === null;
}

/**
 * Build a `ClientSDK` bound to the caller's current `ToolContext`. The SDK
 * exposes `.org()` which constructs a fresh `ClientSDK` after re-validating
 * membership against the shared auth-layer cache.
 */
export function buildClientSDK(ctx: ToolContext, env: Env): ClientSDK {
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
    organizations: buildOrganizationsNamespace(ctx),

    async org(slugOrId) {
      const member = await resolveOrgMembership(slugOrId, ctx);
      const swapped: ToolContext = {
        ...ctx,
        organizationId: member.orgId,
        memberRole: member.role,
      };
      return buildClientSDK(swapped, env);
    },

    async query(querySql) {
      // Mirrors `query_sql` MCP tool: admin/owner only for user sessions,
      // even though the method is read-only. The query allowlist exposes
      // audit/event tables that should not be reachable by member-tier callers
      // via `execute`. Watcher reactions remain system calls and are allowed.
      if (!isSystemContext(ctx)) {
        if (ctx.memberRole !== "owner" && ctx.memberRole !== "admin") {
          throw new AccessDeniedError(
            "client.query requires admin or owner access in the current organization.",
          );
        }
        if (!hasRequiredMcpScope("admin", ctx.scopes)) {
          throw new AccessDeniedError(
            "client.query requires an MCP session with admin access.",
          );
        }
      }
      const [{ getDb }, { validateAndScopeQuery }] = await Promise.all([
        import("../db/client"),
        import("../utils/execute-data-sources"),
      ]);
      const scoped = validateAndScopeQuery(querySql, ctx.organizationId);
      const db = getDb();
      const rows = await db.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx.unsafe("SET LOCAL statement_timeout = '5000'");
        return tx.unsafe(scoped.sql, scoped.params as unknown[]);
      });
      return rows.map((r: Record<string, unknown>) => ({ ...r }));
    },

    log(message, data) {
      // Structured log; PR-3 routes these into the execute_invocation audit row.
      // biome-ignore lint/suspicious/noConsole: dev-level fallback; PR-3 swaps for a proper sink.
      console.log(`[client-sdk] ${message}`, data ?? {});
    },
  };

  return sdk;
}
