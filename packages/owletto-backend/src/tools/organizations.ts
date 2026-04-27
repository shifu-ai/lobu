/**
 * Tool: list_organizations
 *
 * Discovery for the orgs the authenticated user belongs to (and any public
 * workspaces the session can read). Exposed on both unscoped /mcp and
 * scoped /mcp/{slug} endpoints. Cross-org reads from inside `execute` go
 * through `client.org(slug)`; scripts that need a different default org
 * should use a different /mcp/{slug} URL or PAT.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { Env } from '../index';
import { getWorkspaceProvider } from '../workspace';
import type { OrgInfo } from '../workspace/types';

export const ListOrganizationsSchema = Type.Object({
  search: Type.Optional(
    Type.String({ description: 'Filter organizations by name (case-insensitive substring match)' })
  ),
});

export async function listOrganizations(
  args: Static<typeof ListOrganizationsSchema>,
  _env: Env,
  ctx: { userId: string }
): Promise<unknown> {
  const provider = getWorkspaceProvider();
  const orgs = await provider.listOrganizations(args.search, ctx.userId);
  return orgs.map((o: OrgInfo) => ({
    slug: o.slug,
    name: o.name,
    is_member: o.is_member,
    visibility: o.visibility,
  }));
}

