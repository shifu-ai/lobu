/**
 * Connector definition CRUD for the embedded Lobu gateway.
 *
 * Org-scoped via mcpAuth + orgContext. Used by `lobu seed` to import
 * `connectors/<key>/` directories from templates and by the admin UI to
 * manage installed connectors.
 *
 * Read endpoints already exist at /api/:orgSlug/public/connectors (public
 * read, used by data-source pickers). These admin endpoints add the write
 * surface (install/uninstall) that didn't exist as HTTP routes before.
 */

import { Hono } from 'hono';
import { mcpAuth } from '../auth/middleware';
import type { Env } from '../index';
import {
  getScopedConnectorDefinition,
  installConnectorDefinitionFromSource,
  installConnectorFromMcpUrl,
  listScopedConnectorDefinitions,
  uninstallConnectorDefinition,
} from '../tools/admin/connector-definition-helpers';
import { orgContext } from './stores/org-context';

const routes = new Hono<{ Bindings: Env }>();

function withOrg(c: any, fn: (organizationId: string) => Promise<Response>): Promise<Response> {
  const orgId = c.get('organizationId');
  if (!orgId) return Promise.resolve(c.json({ error: 'Organization required' }, 401));
  return orgContext.run({ organizationId: orgId }, () => fn(orgId));
}

// ── List connectors ──────────────────────────────────────────────────────────

routes.get('/', mcpAuth, async (c) => {
  return withOrg(c, async (organizationId) => {
    const rows = await listScopedConnectorDefinitions({ organizationId });
    return c.json({
      connectors: rows.map(({ source_path: _sp, actions_schema: _as, ...rest }) => rest),
    });
  });
});

// ── Get connector ────────────────────────────────────────────────────────────

routes.get('/:connectorKey', mcpAuth, async (c) => {
  return withOrg(c, async (organizationId) => {
    const { connectorKey } = c.req.param();
    const connector = await getScopedConnectorDefinition({
      organizationId,
      connectorKey,
    });
    if (!connector) return c.json({ error: 'Connector not found' }, 404);
    const { source_path: _sp, ...rest } = connector;
    return c.json({ connector: rest });
  });
});

// ── Install connector ────────────────────────────────────────────────────────
//
// Body forms (mutually exclusive):
//   { sourceCode, compiled?: boolean }      — paste compiled JS or TS source
//   { sourceUrl }                           — fetch from a URL (npm tarball, gist, etc.)
//   { sourceUri }                           — file:// or pkg: URI
//   { mcpUrl }                              — generate a connector that proxies an MCP server

routes.post('/', mcpAuth, async (c) => {
  return withOrg(c, async (organizationId) => {
    const body = await c.req.json<{
      sourceCode?: string;
      sourceUrl?: string;
      sourceUri?: string;
      mcpUrl?: string;
      compiled?: boolean;
    }>();

    const { sourceCode, sourceUrl, sourceUri, mcpUrl, compiled } = body;
    const sourceCount = [sourceCode, sourceUrl, sourceUri, mcpUrl].filter(Boolean).length;
    if (sourceCount === 0) {
      return c.json(
        {
          error: 'one of sourceCode, sourceUrl, sourceUri, or mcpUrl is required',
        },
        400
      );
    }
    if (sourceCount > 1) {
      return c.json(
        { error: 'sourceCode, sourceUrl, sourceUri, and mcpUrl are mutually exclusive' },
        400
      );
    }

    try {
      const result = mcpUrl
        ? await installConnectorFromMcpUrl({ organizationId, mcpUrl })
        : await installConnectorDefinitionFromSource({
            organizationId,
            sourceCode,
            sourceUrl,
            sourceUri,
            compiled,
          });
      return c.json({ connector: result }, result.updated ? 200 : 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'install failed';
      return c.json({ error: message }, 400);
    }
  });
});

// ── Uninstall connector ──────────────────────────────────────────────────────

routes.delete('/:connectorKey', mcpAuth, async (c) => {
  return withOrg(c, async (organizationId) => {
    const { connectorKey } = c.req.param();
    try {
      const archived = await uninstallConnectorDefinition({
        organizationId,
        connectorKey,
      });
      if (!archived) return c.json({ error: 'Connector not found' }, 404);
      return c.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'uninstall failed';
      // Helper throws when active connections still reference the connector.
      return c.json({ error: message }, 409);
    }
  });
});

export { routes as connectorRoutes };
