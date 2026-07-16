/**
 * Toolbox/Gateway provisioning API for deterministic ShiFu user agents.
 *
 * This lives under the embedded `/lobu` app so it can use the same org-pinned
 * PAT path as LINE Gateway runtime calls. It intentionally exposes only a
 * narrow upsert surface: Toolbox supplies deterministic metadata/settings, and
 * Lobu stores them in the PAT's organization.
 */

import { createHash } from "node:crypto";
import type { AgentSettings, StoredConnection } from "@lobu/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { canonicalize } from "json-canonicalize";
import type { McpConfigService } from "../gateway/auth/mcp/config-service.js";
import { startAuthCodeFlow } from "../gateway/auth/mcp/oauth-flow.js";
import { GrantStore } from "../gateway/permissions/grant-store.js";
import {
  getStoredCredential,
  refreshCredential,
} from "../gateway/routes/internal/device-auth.js";
import type { WritableSecretStore } from "../gateway/secrets/index.js";
import type { Env } from "../index";
import {
  AgentReleaseError,
  createAgentReleaseService,
} from "./agent-release-service.js";
import {
  AgentSettingsManagedByFencedProvisioningError,
  AgentSettingsManagedByReleaseError,
  ProvisioningFenceError,
  provisionFencedAgent,
  provisionLegacyAgent,
} from "./legacy-agent-settings-service.js";
import {
  validateExpectedGrantPatterns,
  verifyRuntimeGrantPatterns,
} from "./runtime-grant-verifier.js";
import {
  type ReconcileSalesBattleReportScheduleInput,
  reconcileSalesBattleReportSchedule,
} from "./sales-battle-report-schedule-reconcile.js";
import {
  AGENT_ID_PATTERN,
  createPostgresAgentConfigStore,
  createPostgresAgentConnectionStore,
} from "./stores/postgres-stores";
import { parseStrictJsonBytes, StrictJsonError } from "./strict-json-parser.js";
import {
  createPostgresEffectiveToolInventoryStore,
  createReleaseAssuranceReadback,
} from "./release-assurance-readback.js";

const SHIFU_USER_AGENT_ID_PATTERN = /^shifu-u-[a-z0-9-]+$/;
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const MAX_AGENT_RELEASE_BODY_BYTES = 1024 * 1024;
const MAX_SALES_BATTLE_REPORT_BODY_BYTES = 64 * 1024;
const MAX_SALES_BATTLE_REPORT_IDENTIFIER_LENGTH = 128;
const MAX_SALES_BATTLE_REPORT_COURSE_NAME_LENGTH = 256;
const SHIFU_UI_MANAGED_MCP_IDS = new Set([
  "google_workspace",
  "notion",
  "shifu_toolbox",
]);

export type ShifuMcpStatusReasonCode =
  | "ok"
  | "missing_credential"
  | "token_expired"
  | "token_refresh_failed"
  | "scope_missing"
  | "connector_not_configured"
  | "mcp_not_found"
  | "provider_error"
  | "runtime_status_unavailable"
  | "ui_unmanaged_connector";

const configStore = createPostgresAgentConfigStore();
const connectionStore = createPostgresAgentConnectionStore();
const grantStore = new GrantStore();

interface ProvisioningRoutesOptions {
  mcpConfigService?: McpConfigService;
  secretStore?: WritableSecretStore;
  publicGatewayUrl?: string;
  agentReleaseTrustedPublicKeysJson?: string;
  agentReleaseEvidenceSigningPrivateKeysJson?: string;
  agentReleaseEnvironment?: string;
  legacyProvisioningHooks?: {
    afterAgentLock?: () => Promise<void>;
  };
  agentReleaseTransactionHooks?: {
    afterAgentLock?: () => Promise<void>;
  };
  releaseAssuranceReadback?: {
    readRuntime(): Promise<unknown>;
    readAgent(input: {
      organizationId: string;
      agentId: string;
    }): Promise<unknown | null>;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireAdminPat(c: Context<{ Bindings: Env }>): Response | null {
  const session = c.get("session") as { id?: string } | null;
  const authSource = c.get("authSource") as "pat" | "session" | "oauth" | null;
  const authInfo = c.get("mcpAuthInfo") as { scopes?: string[] } | null;
  const scopes = Array.isArray(authInfo?.scopes) ? authInfo.scopes : [];

  if (
    authSource === "pat" &&
    session?.id?.startsWith("pat:") &&
    scopes.includes("mcp:admin")
  ) {
    return null;
  }

  return c.json(
    {
      error: "forbidden",
      error_description:
        "Provisioning requires an organization-scoped PAT with mcp:admin scope.",
    },
    403
  );
}

function validateSettings(settings: unknown): Omit<AgentSettings, "updatedAt"> {
  if (settings === undefined) return {};
  if (!isObject(settings)) {
    throw new Error("settings must be an object");
  }
  return settings as Omit<AgentSettings, "updatedAt">;
}

function validateShifuAgentId(agentId: string): string | null {
  if (
    !AGENT_ID_PATTERN.test(agentId) ||
    !SHIFU_USER_AGENT_ID_PATTERN.test(agentId)
  ) {
    return "agentId must be a Lobu-safe ShiFu user agent id starting with shifu-u-";
  }
  return null;
}

function parseUserId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASELINE_VERSION_PATTERN = /^personal-agent-baseline-v1-[0-9a-f]{64}$/;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requestDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function isUiManagedMcp(mcpId: string): boolean {
  return SHIFU_UI_MANAGED_MCP_IDS.has(mcpId);
}

export function statusReasonForConnector(input: {
  configured: boolean;
  authorized: boolean;
  oauthStatus: "authorized" | "needs_reauth" | "not_connected" | "unknown";
  uiManaged: boolean;
}): ShifuMcpStatusReasonCode {
  if (!input.uiManaged) return "ui_unmanaged_connector";
  if (!input.configured) return "connector_not_configured";
  if (input.oauthStatus === "needs_reauth") return "token_expired";
  if (input.oauthStatus === "unknown") return "runtime_status_unavailable";
  if (!input.authorized) return "missing_credential";
  return "ok";
}

async function isOwnedByToolboxUser(
  agentId: string,
  userId: string
): Promise<boolean> {
  const metadata = await configStore.getMetadata(agentId);
  return Boolean(metadata && metadata.owner?.userId === userId);
}

function deterministicProvisionedMcpConnectionRef(
  organizationId: string,
  userId: string,
  agentId: string,
  mcpId: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([organizationId, userId, agentId, mcpId]))
    .digest("hex");
  return `toolbox-mcp:${digest}`;
}

function deterministicMembershipId(
  organizationId: string,
  ownerUserId: string
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId])
    )
    .digest("hex")
    .slice(0, 24);
  return `member_${digest}`;
}

function deterministicToolboxOwnerEmail(
  organizationId: string,
  ownerUserId: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([organizationId, ownerUserId]))
    .digest("hex")
    .slice(0, 32);
  return `toolbox-owner-${digest}@toolbox.local`;
}

function redirectUri(publicGatewayUrl: string): string {
  return `${publicGatewayUrl.replace(/\/+$/, "")}/mcp/oauth/callback`;
}

async function ensureUsableOAuthCredential(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string,
  credential: Awaited<ReturnType<typeof getStoredCredential>> | null
): Promise<Awaited<ReturnType<typeof getStoredCredential>> | null> {
  if (!credential) return null;
  if (credential.expiresAt > Date.now() + OAUTH_EXPIRY_BUFFER_MS) {
    return credential;
  }
  if (!credential.refreshToken) return null;
  const refreshed = await refreshCredential(
    secretStore,
    agentId,
    userId,
    mcpId,
    credential
  );
  return refreshed;
}

async function syncProvisioningGrants(
  agentId: string,
  settings: Omit<AgentSettings, "updatedAt">,
  organizationId: string
): Promise<void> {
  for (const domain of settings.networkConfig?.allowedDomains ?? []) {
    await grantStore.grant(agentId, domain, null, undefined, organizationId);
  }
  for (const pattern of settings.preApprovedTools ?? []) {
    await grantStore.grant(agentId, pattern, null, undefined, organizationId);
  }
}

export function createProvisioningRoutes(
  options: ProvisioningRoutesOptions = {}
): Hono<{ Bindings: Env }> {
  const provisioningRoutes = new Hono<{ Bindings: Env }>();
  const agentReleaseService = createAgentReleaseService({
    trustedPublicKeysJson:
      options.agentReleaseTrustedPublicKeysJson ??
      process.env.AGENT_RELEASE_TRUSTED_PUBLIC_KEYS_JSON,
    evidenceSigningPrivateKeysJson:
      options.agentReleaseEvidenceSigningPrivateKeysJson ??
      process.env.AGENT_RELEASE_EVIDENCE_SIGNING_PRIVATE_KEYS_JSON,
    expectedEnvironment:
      options.agentReleaseEnvironment ?? process.env.AGENT_RELEASE_ENVIRONMENT,
    transactionHooks: options.agentReleaseTransactionHooks,
  });
  const releaseAssuranceReadback =
    options.releaseAssuranceReadback ??
    createReleaseAssuranceReadback({
      findAgentBase: async ({
        organizationId,
        agentId,
      }: {
        organizationId: string;
        agentId: string;
      }) => {
        const metadata = await configStore.getMetadata(agentId);
        if (!metadata || metadata.organizationId !== organizationId)
          return null;
        const receipt = await agentReleaseService.getEvidence({
          organizationId,
          agentId,
        });
        return {
          managedReleaseReceipt: receipt,
          liveManagedSettingsDigest:
            receipt?.status === "drifted"
              ? (receipt.liveSettingsHash ?? null)
              : (receipt?.settingsHash ?? null),
        };
      },
    });

  provisioningRoutes.get("/release-assurance", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;
    const organizationId = c.get("organizationId") as string | null;
    if (!organizationId)
      return c.json({ error: "Authentication required" }, 401);
    return c.json(await releaseAssuranceReadback.readRuntime(), 200);
  });

  provisioningRoutes.put(
    "/sales-battle-report-schedules/:toolboxScheduleId",
    bodyLimit({
      maxSize: MAX_SALES_BATTLE_REPORT_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "sales_battle_report_schedule_body_too_large" }, 413),
    }),
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      const authenticatedOrganizationId = c.get("organizationId") as
        | string
        | null;
      if (!authenticatedOrganizationId) {
        return c.json({ error: "Authentication required" }, 401);
      }

      let body: Partial<ReconcileSalesBattleReportScheduleInput>;
      try {
        const parsed: unknown = await c.req.json();
        if (!isObject(parsed)) {
          return c.json({ error: "invalid_sales_battle_report_schedule" }, 400);
        }
        body = parsed;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return c.json({ error: "invalid_json" }, 400);
      }

      const toolboxScheduleId = c.req.param("toolboxScheduleId").trim();
      const organizationId =
        typeof body.organizationId === "string"
          ? body.organizationId.trim()
          : "";
      const createdByUser =
        typeof body.createdByUser === "string" ? body.createdByUser.trim() : "";
      const agentId =
        typeof body.agentId === "string" ? body.agentId.trim() : "";
      const courseName =
        typeof body.courseName === "string" ? body.courseName.trim() : "";
      const desiredState = body.desiredState;
      const weekdays = Array.isArray(body.salesTalkWeekdays)
        ? [...new Set(body.salesTalkWeekdays)]
        : [];
      if (
        !toolboxScheduleId ||
        toolboxScheduleId.length > MAX_SALES_BATTLE_REPORT_IDENTIFIER_LENGTH ||
        !organizationId ||
        !createdByUser ||
        createdByUser.length > MAX_SALES_BATTLE_REPORT_IDENTIFIER_LENGTH ||
        !agentId ||
        agentId.length > MAX_SALES_BATTLE_REPORT_IDENTIFIER_LENGTH ||
        !courseName ||
        courseName.length > MAX_SALES_BATTLE_REPORT_COURSE_NAME_LENGTH ||
        !Number.isSafeInteger(body.scheduleRevision) ||
        Number(body.scheduleRevision) < 1 ||
        Number(body.scheduleRevision) > 2_147_483_647 ||
        !weekdays.length ||
        !weekdays.every(
          (weekday) =>
            Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
        ) ||
        !(["active", "paused", "deleted"] as const).includes(
          desiredState as "active" | "paused" | "deleted"
        )
      ) {
        return c.json({ error: "invalid_sales_battle_report_schedule" }, 400);
      }
      if (organizationId !== authenticatedOrganizationId) {
        return c.json(
          { error: "organizationId does not match authenticated org" },
          403
        );
      }

      const result = await reconcileSalesBattleReportSchedule({
        organizationId,
        createdByUser,
        agentId,
        toolboxScheduleId,
        scheduleRevision: Number(body.scheduleRevision),
        courseName,
        salesTalkWeekdays: weekdays as number[],
        desiredState: desiredState as "active" | "paused" | "deleted",
      });
      if (!result.ok) {
        if (
          result.error === "stale_revision" ||
          result.error === "revision_payload_conflict"
        ) {
          return c.json(
            {
              error: result.error,
              acceptedRevision: result.acceptedRevision,
            },
            409
          );
        }
        return c.json(
          {
            error: result.error,
            conflictingJobIds: result.conflictingJobIds,
          },
          409
        );
      }
      return c.json(result, 200);
    }
  );

  provisioningRoutes.get("/agents/:agentId/release-assurance", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;
    const organizationId = c.get("organizationId") as string | null;
    if (!organizationId)
      return c.json({ error: "Authentication required" }, 401);
    const agentId = c.req.param("agentId")?.trim() ?? "";
    const agentIdError = validateShifuAgentId(agentId);
    if (agentIdError) return c.json({ error: agentIdError }, 400);
    const result = await releaseAssuranceReadback.readAgent({
      organizationId,
      agentId,
    });
    if (!result)
      return c.json({ error: "agent_release_assurance_not_found" }, 404);
    return c.json(result, 200);
  });

  provisioningRoutes.put(
    "/agents/:agentId/fenced-settings",
    bodyLimit({
      maxSize: MAX_AGENT_RELEASE_BODY_BYTES,
      onError: (c) => c.json({ error: "provisioning_body_too_large" }, 413),
    }),
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;
      const user = c.get("user") as { id?: string } | null;
      const organizationId = c.get("organizationId") as string | null;
      if (!user?.id || !organizationId) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const agentId = c.req.param("agentId")?.trim() ?? "";
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);

      let body: Record<string, unknown>;
      try {
        const parsed = parseStrictJsonBytes(
          new Uint8Array(await c.req.arrayBuffer())
        );
        if (!isObject(parsed))
          throw new StrictJsonError(
            "invalid_json",
            "JSON body must be an object"
          );
        body = parsed;
      } catch (error) {
        if (error instanceof StrictJsonError) {
          return c.json({ error: "invalid_json" }, 400);
        }
        throw error;
      }

      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description =
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : undefined;
      const ownerUserId = parseUserId(body.ownerUserId);
      const targetId = typeof body.targetId === "string" ? body.targetId : "";
      const claimGeneration = body.claimGeneration;
      const claimToken =
        typeof body.claimToken === "string" ? body.claimToken : "";
      const baselineVersionId =
        typeof body.baselineVersionId === "string"
          ? body.baselineVersionId
          : "";
      const effectiveSettingsDigest =
        typeof body.effectiveSettingsDigest === "string"
          ? body.effectiveSettingsDigest
          : "";

      if (!name || name.length > 200) {
        return c.json({ error: "name must contain 1 to 200 characters" }, 400);
      }
      if (description && description.length > 2000) {
        return c.json(
          { error: "description must not exceed 2000 characters" },
          400
        );
      }
      if (!ownerUserId || ownerUserId.length > 200) {
        return c.json(
          { error: "ownerUserId must contain 1 to 200 characters" },
          400
        );
      }
      if (!UUID_PATTERN.test(targetId)) {
        return c.json({ error: "targetId must be a lowercase UUID" }, 400);
      }
      if (
        typeof claimGeneration !== "number" ||
        !Number.isSafeInteger(claimGeneration) ||
        claimGeneration <= 0
      ) {
        return c.json(
          { error: "claimGeneration must be a positive safe integer" },
          400
        );
      }
      if (!UUID_PATTERN.test(claimToken)) {
        return c.json({ error: "claimToken must be a lowercase UUID" }, 400);
      }
      if (!BASELINE_VERSION_PATTERN.test(baselineVersionId)) {
        return c.json(
          { error: "baselineVersionId has an invalid format" },
          400
        );
      }
      if (!SHA256_DIGEST_PATTERN.test(effectiveSettingsDigest)) {
        return c.json(
          { error: "effectiveSettingsDigest has an invalid format" },
          400
        );
      }

      let settings: Omit<AgentSettings, "updatedAt">;
      if (body.settings === undefined) {
        return c.json({ error: "settings is required" }, 400);
      }
      try {
        settings = validateSettings(body.settings);
      } catch (error) {
        return c.json(
          {
            error: error instanceof Error ? error.message : "Invalid settings",
          },
          400
        );
      }

      const fence = {
        targetId,
        claimGeneration,
        claimToken,
        baselineVersionId,
        effectiveSettingsDigest,
      };
      try {
        const result = await provisionFencedAgent({
          organizationId,
          agentId,
          name,
          description,
          ownerUserId,
          patUserId: user.id,
          membershipId: deterministicMembershipId(organizationId, ownerUserId),
          ownerEmail: deterministicToolboxOwnerEmail(
            organizationId,
            ownerUserId
          ),
          settings,
          fence,
          requestDigest: requestDigest({
            agentId,
            name,
            description: description ?? null,
            ownerUserId,
            settings,
            ...fence,
          }),
        });
        return c.json(
          {
            ok: true,
            agentId,
            created: result.created,
            membership: result.membership,
            revisionRef: `lobu:${agentId}`,
            provisioningFence: fence,
          },
          result.created ? 201 : 200
        );
      } catch (error) {
        if (error instanceof ProvisioningFenceError) {
          return c.json({ error: error.code }, 409);
        }
        if (error instanceof AgentSettingsManagedByReleaseError) {
          return c.json({ error: error.code }, 409);
        }
        throw error;
      }
    }
  );

  provisioningRoutes.post("/agents", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const user = c.get("user") as { id?: string } | null;
    const organizationId = c.get("organizationId") as string | null;
    if (!user?.id || !organizationId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    let body: {
      agentId?: unknown;
      name?: unknown;
      description?: unknown;
      ownerUserId?: unknown;
      settings?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : undefined;

    if (!agentId || !name) {
      return c.json({ error: "agentId and name are required" }, 400);
    }
    const agentIdError = validateShifuAgentId(agentId);
    if (agentIdError) {
      return c.json({ error: agentIdError }, 400);
    }
    const ownerUserId =
      body.ownerUserId === undefined
        ? user.id
        : typeof body.ownerUserId === "string"
          ? body.ownerUserId.trim()
          : "";
    if (!ownerUserId) {
      return c.json(
        { error: "ownerUserId must be a non-empty string when provided" },
        400
      );
    }

    let settings: Omit<AgentSettings, "updatedAt">;
    try {
      settings = validateSettings(body.settings);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : "Invalid settings" },
        400
      );
    }

    let provisioned: Awaited<ReturnType<typeof provisionLegacyAgent>>;
    try {
      provisioned = await provisionLegacyAgent({
        organizationId,
        agentId,
        name,
        description,
        ownerUserId,
        patUserId: user.id,
        membershipId: deterministicMembershipId(organizationId, ownerUserId),
        ownerEmail: deterministicToolboxOwnerEmail(organizationId, ownerUserId),
        settings,
        transactionHooks: options.legacyProvisioningHooks,
      });
    } catch (error) {
      if (error instanceof AgentSettingsManagedByFencedProvisioningError) {
        return c.json({ error: error.code }, 409);
      }
      if (error instanceof AgentSettingsManagedByReleaseError) {
        return c.json(
          { error: error.code, error_description: error.message },
          409
        );
      }
      throw error;
    }
    await syncProvisioningGrants(agentId, settings, organizationId);

    return c.json(
      {
        ok: true,
        agentId,
        created: provisioned.created,
        membership: provisioned.membership,
        revisionRef: `lobu:${agentId}`,
      },
      provisioned.created ? 201 : 200
    );
  });

  provisioningRoutes.get("/agents/:agentId/settings", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const agentId = c.req.param("agentId")?.trim() ?? "";
    const agentIdError = validateShifuAgentId(agentId);
    if (agentIdError) return c.json({ error: agentIdError }, 400);

    const settings = await configStore.getSettings(agentId);
    if (!settings) return c.json({ error: "Agent not found" }, 404);

    return c.json({
      ok: true,
      agentId,
      settings,
    });
  });

  provisioningRoutes.put(
    "/agents/:agentId/managed-settings",
    bodyLimit({
      maxSize: MAX_AGENT_RELEASE_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: "agent_release_body_too_large",
            error_description: "Agent release body exceeds one MiB",
          },
          413
        ),
    }),
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      const organizationId = c.get("organizationId") as string | null;
      if (!organizationId)
        return c.json({ error: "Authentication required" }, 401);
      const agentId = c.req.param("agentId")?.trim() ?? "";
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);

      let command: unknown;
      try {
        command = parseStrictJsonBytes(
          new Uint8Array(await c.req.arrayBuffer())
        );
      } catch (error) {
        if (error instanceof StrictJsonError) {
          return c.json(
            {
              error:
                error.code === "duplicate_json_member"
                  ? "agent_release_duplicate_json_member"
                  : "invalid_json",
              error_description: error.message,
            },
            400
          );
        }
        throw error;
      }

      try {
        const result = await agentReleaseService.apply({
          organizationId,
          agentId,
          command,
        });
        return c.json(result, 200);
      } catch (error) {
        if (error instanceof AgentReleaseError) {
          return c.json(
            { error: error.code, error_description: error.message },
            error.status
          );
        }
        throw error;
      }
    }
  );

  provisioningRoutes.get("/agents/:agentId/managed-settings", async (c) => {
    const denied = requireAdminPat(c);
    if (denied) return denied;

    const organizationId = c.get("organizationId") as string | null;
    if (!organizationId)
      return c.json({ error: "Authentication required" }, 401);
    const agentId = c.req.param("agentId")?.trim() ?? "";
    const agentIdError = validateShifuAgentId(agentId);
    if (agentIdError) return c.json({ error: agentIdError }, 400);

    try {
      const evidence = await agentReleaseService.getEvidence({
        organizationId,
        agentId,
      });
      if (!evidence)
        return c.json({ error: "agent_release_evidence_not_found" }, 404);
      return c.json(evidence, 200);
    } catch (error) {
      if (error instanceof AgentReleaseError) {
        return c.json(
          { error: error.code, error_description: error.message },
          error.status
        );
      }
      throw error;
    }
  });

  provisioningRoutes.post(
    "/agents/:agentId/runtime-grants/verify",
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      const agentId = c.req.param("agentId")?.trim() ?? "";
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);

      let body: {
        userId?: unknown;
        revisionId?: unknown;
        expectedGrantPatterns?: unknown;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }

      const userId = parseUserId(body.userId);
      if (userId && !(await isOwnedByToolboxUser(agentId, userId))) {
        return c.json({ error: "agent_owner_mismatch" }, 404);
      }

      const revisionId =
        typeof body.revisionId === "string" && body.revisionId.trim()
          ? body.revisionId.trim()
          : "runtime_grants";

      let expectedGrantPatterns: string[];
      try {
        expectedGrantPatterns = validateExpectedGrantPatterns(
          body.expectedGrantPatterns
        );
      } catch (error) {
        return c.json(
          {
            ok: false,
            errorCode: "invalid_expected_grant_patterns",
            userVisibleSummary:
              error instanceof Error
                ? error.message
                : "Invalid expected grant patterns",
          },
          400
        );
      }

      const organizationId = c.get("organizationId") as string | null;
      if (!organizationId)
        return c.json({ error: "Authentication required" }, 401);

      const result = await verifyRuntimeGrantPatterns({
        grantStore,
        agentId,
        organizationId,
        revisionId,
        expectedGrantPatterns,
      });
      return c.json(result, 200);
    }
  );

  provisioningRoutes.post(
    "/agents/:agentId/mcp/:mcpId/oauth/start",
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      if (!options.mcpConfigService || !options.secretStore) {
        return c.json(
          {
            error: "oauth_unavailable",
            error_description:
              "MCP OAuth provisioning requires gateway OAuth services.",
          },
          503
        );
      }

      const agentId = c.req.param("agentId")?.trim() ?? "";
      const mcpId = c.req.param("mcpId")?.trim() ?? "";
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);
      if (!mcpId) return c.json({ error: "mcpId is required" }, 400);

      let body: { userId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const userId = parseUserId(body.userId);
      if (!userId) return c.json({ error: "userId is required" }, 400);
      const organizationId = c.get("organizationId") as string | null;

      if (!(await isOwnedByToolboxUser(agentId, userId))) {
        return c.json({ error: "agent_owner_mismatch" }, 404);
      }

      const httpServer = await options.mcpConfigService.getHttpServer(
        mcpId,
        agentId
      );
      if (!httpServer) {
        return c.json({ error: "mcp_not_found" }, 404);
      }

      const { authorizationUrl } = await startAuthCodeFlow({
        secretStore: options.secretStore,
        mcpId,
        upstreamUrl: httpServer.upstreamUrl,
        agentId,
        userId,
        scopeKey: userId,
        wwwAuthenticate: null,
        redirectUri: redirectUri(options.publicGatewayUrl ?? ""),
        staticOauth: httpServer.oauth,
        platform: "toolbox-web",
        channelId: "",
        conversationId: "",
        resumeMode: "none",
        organizationId: organizationId ?? undefined,
      });

      return c.json({
        ok: true,
        agentId,
        userId,
        mcpId,
        authorizationUrl,
      });
    }
  );

  provisioningRoutes.get(
    "/agents/:agentId/mcp/:mcpId/oauth/status",
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      if (!options.mcpConfigService || !options.secretStore) {
        return c.json(
          {
            error: "oauth_unavailable",
            error_description:
              "MCP OAuth provisioning requires gateway OAuth services.",
          },
          503
        );
      }

      const agentId = c.req.param("agentId")?.trim() ?? "";
      const mcpId = c.req.param("mcpId")?.trim() ?? "";
      const userId = parseUserId(c.req.query("userId"));
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);
      if (!mcpId) return c.json({ error: "mcpId is required" }, 400);
      if (!userId) return c.json({ error: "userId is required" }, 400);

      if (!(await isOwnedByToolboxUser(agentId, userId))) {
        return c.json({ error: "agent_owner_mismatch" }, 404);
      }

      const httpServer = await options.mcpConfigService.getHttpServer(
        mcpId,
        agentId
      );
      if (!httpServer) {
        return c.json({ error: "mcp_not_found" }, 404);
      }

      const credential = await getStoredCredential(
        options.secretStore,
        agentId,
        userId,
        mcpId
      );
      const usableCredential = await ensureUsableOAuthCredential(
        options.secretStore,
        agentId,
        userId,
        mcpId,
        credential
      );

      return c.json({
        ok: true,
        agentId,
        userId,
        mcpId,
        authenticated: !!usableCredential,
        ...(usableCredential?.expiresAt
          ? { expiresAt: usableCredential.expiresAt }
          : {}),
      });
    }
  );

  provisioningRoutes.post(
    "/agents/:agentId/mcp/:mcpId/oauth/materialize",
    async (c) => {
      const denied = requireAdminPat(c);
      if (denied) return denied;

      if (!options.mcpConfigService || !options.secretStore) {
        return c.json(
          {
            error: "oauth_unavailable",
            error_description:
              "MCP OAuth provisioning requires gateway OAuth services.",
          },
          503
        );
      }

      const agentId = c.req.param("agentId")?.trim() ?? "";
      const mcpId = c.req.param("mcpId")?.trim() ?? "";
      const agentIdError = validateShifuAgentId(agentId);
      if (agentIdError) return c.json({ error: agentIdError }, 400);
      if (!mcpId) return c.json({ error: "mcpId is required" }, 400);

      let body: { userId?: unknown; connectorKey?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const userId = parseUserId(body.userId);
      const connectorKey =
        typeof body.connectorKey === "string" && body.connectorKey.trim()
          ? body.connectorKey.trim()
          : mcpId;
      if (!userId) return c.json({ error: "userId is required" }, 400);

      const organizationId = c.get("organizationId") as string | null;
      if (!organizationId)
        return c.json({ error: "Authentication required" }, 401);

      if (!(await isOwnedByToolboxUser(agentId, userId))) {
        return c.json({ error: "agent_owner_mismatch" }, 404);
      }

      const httpServer = await options.mcpConfigService.getHttpServer(
        mcpId,
        agentId
      );
      if (!httpServer) {
        return c.json({ error: "mcp_not_found" }, 404);
      }

      const credential = await getStoredCredential(
        options.secretStore,
        agentId,
        userId,
        mcpId
      );
      if (!credential) {
        return c.json({
          ok: true,
          agentId,
          userId,
          mcpId,
          status: "not_connected",
          lobuConnectionRef: null,
        });
      }
      if (
        !(await ensureUsableOAuthCredential(
          options.secretStore,
          agentId,
          userId,
          mcpId,
          credential
        ))
      ) {
        return c.json({
          ok: true,
          agentId,
          userId,
          mcpId,
          status: "needs_reauth",
          lobuConnectionRef: null,
        });
      }

      const now = Date.now();
      const connectionRef = deterministicProvisionedMcpConnectionRef(
        organizationId,
        userId,
        agentId,
        mcpId
      );
      const connection: StoredConnection = {
        id: connectionRef,
        organizationId,
        agentId,
        platform: connectorKey,
        config: {},
        settings: {},
        metadata: {
          ownerUserId: userId,
          connectorKey,
          provider: connectorKey,
          mcpId,
          source: "toolbox-personal-agent-materialized",
          authSource: "lobu_oauth",
        },
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await connectionStore.saveConnection(connection);

      return c.json({
        ok: true,
        agentId,
        userId,
        mcpId,
        status: "ready",
        lobuConnectionRef: connectionRef,
      });
    }
  );

  return provisioningRoutes;
}

export const provisioningRoutes = createProvisioningRoutes();
export { createReleaseAssuranceReadback };
export { createPostgresEffectiveToolInventoryStore };
