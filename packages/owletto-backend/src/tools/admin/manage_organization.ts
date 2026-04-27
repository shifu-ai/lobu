/**
 * Tool: manage_organization
 *
 * Org-scoped settings (toggles + small flags). Today this surfaces the
 * connector repair-agent kill switch; new org-level toggles should land
 * here rather than scattered into bespoke routes.
 *
 * Actions:
 * - get_settings: Read the org settings record.
 * - update_settings: Patch the editable fields (caller-provided fields only).
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';

// ============================================
// Schema
// ============================================

const GetSettingsAction = Type.Object({
  action: Type.Literal('get_settings'),
});

const UpdateSettingsAction = Type.Object({
  action: Type.Literal('update_settings'),
  repair_agents_enabled: Type.Optional(
    Type.Boolean({
      description:
        'Per-org kill switch for connector repair agents. When false, no repair threads are opened for any feed in the org regardless of per-feed configuration.',
    })
  ),
});

export const ManageOrganizationSchema = Type.Union([GetSettingsAction, UpdateSettingsAction]);

// ============================================
// Result Types
// ============================================

export interface OrganizationSettings {
  organization_id: string;
  repair_agents_enabled: boolean;
}

type ManageOrganizationResult =
  | { error: string }
  | { action: 'get_settings'; settings: OrganizationSettings }
  | { action: 'update_settings'; settings: OrganizationSettings };

type OrganizationArgs = Static<typeof ManageOrganizationSchema>;

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageOrganization(
  args: OrganizationArgs,
  ctx: ToolContext
): Promise<ManageOrganizationResult> {
  return routeAction<ManageOrganizationResult>('manage_organization', args.action, ctx, {
    get_settings: () => handleGetSettings(ctx),
    update_settings: () =>
      handleUpdateSettings(args as Extract<OrganizationArgs, { action: 'update_settings' }>, ctx),
  });
}

// ============================================
// Action Handlers
// ============================================

async function handleGetSettings(ctx: ToolContext): Promise<ManageOrganizationResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = (await sql`
    SELECT id, repair_agents_enabled
    FROM "organization"
    WHERE id = ${organizationId}
    LIMIT 1
  `) as unknown as Array<{ id: string; repair_agents_enabled: boolean }>;

  if (rows.length === 0) {
    return { error: 'Organization not found' };
  }

  return {
    action: 'get_settings',
    settings: {
      organization_id: rows[0].id,
      repair_agents_enabled: Boolean(rows[0].repair_agents_enabled),
    },
  };
}

async function handleUpdateSettings(
  args: Extract<OrganizationArgs, { action: 'update_settings' }>,
  ctx: ToolContext
): Promise<ManageOrganizationResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Only patch fields the caller provided.
  const hasRepairToggle = Object.hasOwn(args, 'repair_agents_enabled');
  if (!hasRepairToggle) {
    return handleGetSettings(ctx);
  }

  const updated = (await sql`
    UPDATE "organization"
    SET repair_agents_enabled = COALESCE(${args.repair_agents_enabled ?? null}::boolean, repair_agents_enabled)
    WHERE id = ${organizationId}
    RETURNING id, repair_agents_enabled
  `) as unknown as Array<{ id: string; repair_agents_enabled: boolean }>;

  if (updated.length === 0) {
    return { error: 'Organization not found' };
  }

  return {
    action: 'update_settings',
    settings: {
      organization_id: updated[0].id,
      repair_agents_enabled: Boolean(updated[0].repair_agents_enabled),
    },
  };
}
