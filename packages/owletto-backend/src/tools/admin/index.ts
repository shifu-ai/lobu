/**
 * Legacy admin tools kept for REST/session callers while external MCP clients
 * use the smaller search/execute surface.
 */

import type { Static } from '@sinclair/typebox';
import type { Env } from '../../index';
import type { ToolContext, ToolDefinition } from '../registry';
import { ManageAuthProfilesSchema, manageAuthProfiles } from './manage_auth_profiles';
import { ManageClassifiersSchema, manageClassifiers } from './manage_classifiers';
import { ManageConnectionsSchema, manageConnections } from './manage_connections';
import { ManageEntitySchema, manageEntity } from './manage_entity';
import { ManageEntitySchemaSchema, manageEntitySchema } from './manage_entity_schema';
import { ManageFeedsSchema, manageFeeds } from './manage_feeds';
import { ManageOperationsSchema, manageOperations } from './manage_operations';
import { ManageViewTemplatesSchema, manageViewTemplates } from './manage_view_templates';
import { ManageWatchersSchema, manageWatchers } from './manage_watchers';

export const LEGACY_ADMIN_TOOLS: ToolDefinition[] = [
  {
    name: 'manage_entity',
    description:
      'Legacy internal entity management tool for REST/session callers. External MCP clients should use execute + client.entities instead.',
    inputSchema: ManageEntitySchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageEntitySchema>, env: Env, ctx: ToolContext) => {
      return await manageEntity(args, env, ctx);
    },
  },
  {
    name: 'manage_entity_schema',
    description:
      'Legacy internal schema management tool for REST/session callers. External MCP clients should use execute + client.entitySchema instead.',
    inputSchema: ManageEntitySchemaSchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageEntitySchemaSchema>, env: Env, ctx: ToolContext) => {
      return await manageEntitySchema(args, env, ctx);
    },
  },
  {
    // Kept on the public MCP surface (not internal) because owletto-cli's
    // `browser-auth` flow drives connection setup via MCP RPC. New external
    // clients should still prefer execute + client.connections; we'll flip
    // this back to internal once the CLI migrates.
    name: 'manage_connections',
    description:
      'Connection management. New external MCP clients should prefer execute + client.connections; this tool is kept public for the owletto-cli browser-auth flow.',
    inputSchema: ManageConnectionsSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageConnectionsSchema>, env: Env, ctx: ToolContext) => {
      return await manageConnections(args, env, ctx);
    },
  },
  {
    name: 'manage_feeds',
    description:
      'Legacy internal feed management tool for REST/session callers. External MCP clients should use execute + client.feeds instead.',
    inputSchema: ManageFeedsSchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageFeedsSchema>, env: Env, ctx: ToolContext) => {
      return await manageFeeds(args, env, ctx);
    },
  },
  {
    // Kept on the public MCP surface (not internal) because owletto-cli's
    // `browser-auth` flow exchanges credential blobs via MCP RPC. New external
    // clients should still prefer execute + client.authProfiles; we'll flip
    // this back to internal once the CLI migrates.
    name: 'manage_auth_profiles',
    description:
      'Auth-profile management. New external MCP clients should prefer execute + client.authProfiles; this tool is kept public for the owletto-cli browser-auth flow.',
    inputSchema: ManageAuthProfilesSchema,
    annotations: { destructiveHint: false },
    handler: async (args: Static<typeof ManageAuthProfilesSchema>, env: Env, ctx: ToolContext) => {
      return await manageAuthProfiles(args, env, ctx);
    },
  },
  {
    name: 'manage_operations',
    description:
      'Legacy internal operations tool for REST/session callers. External MCP clients should use execute + client.operations instead.',
    inputSchema: ManageOperationsSchema,
    annotations: { destructiveHint: false, openWorldHint: true },
    internal: true,
    handler: async (args: Static<typeof ManageOperationsSchema>, env: Env, ctx: ToolContext) => {
      return await manageOperations(args, env, ctx);
    },
  },
  {
    name: 'manage_watchers',
    description:
      'Legacy internal watcher management tool for REST/session callers. External MCP clients should use execute + client.watchers instead.',
    inputSchema: ManageWatchersSchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageWatchersSchema>, env: Env, ctx: ToolContext) => {
      return await manageWatchers(args, env, ctx);
    },
  },
  {
    name: 'manage_classifiers',
    description:
      'Legacy internal classifier management tool for REST/session callers. External MCP clients should use execute + client.classifiers instead.',
    inputSchema: ManageClassifiersSchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageClassifiersSchema>, env: Env, ctx: ToolContext) => {
      return await manageClassifiers(args, env, ctx);
    },
  },
  {
    name: 'manage_view_templates',
    description:
      'Legacy internal view-template management tool for REST/session callers. External MCP clients should use execute + client.viewTemplates instead.',
    inputSchema: ManageViewTemplatesSchema,
    annotations: { destructiveHint: false },
    internal: true,
    handler: async (args: Static<typeof ManageViewTemplatesSchema>, env: Env, ctx: ToolContext) => {
      return await manageViewTemplates(args, env, ctx);
    },
  },
];
