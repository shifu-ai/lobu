/**
 * ClientSDK method metadata.
 *
 * Describes each SDK method for:
 * - `search` MCP tool (summary, example, throws)
 * - Dry-run classification (read | write | external) — PR-2 wires this into
 *   the wrapper so writes and external side-effects are intercepted.
 * - Static bans (e.g. `client.execute` must not be exposed recursively)
 *
 * Keyed by dotted SDK path (e.g. `watchers.list`, `entities.create`). The
 * PR-1 coverage unit test asserts every method exported from a namespace has
 * an entry here.
 */

export type MethodAccess = "read" | "write" | "external";

export interface MethodMetadata {
  /** One-line human description. Shown in namespace listings. */
  summary: string;
  /** Dry-run classification. Writes are intercepted; externals are never sent. */
  access: MethodAccess;
  /** Declared error names the method may throw. Surfaces in drill-down. */
  throws?: readonly string[];
  /** Copy-pasteable TS snippet. Kept short (≤2 lines). */
  example?: string;
  /** Cost hint: 'cheap' | 'normal' | 'expensive'. Normal if omitted. */
  cost?: "cheap" | "normal" | "expensive";
}

export const METHOD_METADATA: Record<string, MethodMetadata> = {
  // organizations
  "organizations.list": {
    summary:
      "List organizations the authenticated user belongs to, plus public orgs they can read.",
    access: "read",
    example: "const orgs = await client.organizations.list();",
  },
  "organizations.current": {
    summary: "Return the session's current organization context.",
    access: "read",
    example: "const org = await client.organizations.current();",
  },

  // entities
  "entities.list": {
    summary: "List entities in the current organization with optional filters.",
    access: "read",
    example:
      "const rows = await client.entities.list({ entity_type: 'company' });",
  },
  "entities.get": {
    summary: "Fetch a single entity by id.",
    access: "read",
    throws: ["EntityNotFound"],
    example: "const entity = await client.entities.get(42);",
  },
  "entities.create": {
    summary:
      "Create an entity with metadata validated against the entity type schema.",
    access: "write",
    throws: ["EntityTypeNotFound", "ValidationError"],
    example:
      "await client.entities.create({ type: 'company', name: 'Acme', metadata: {} });",
  },
  "entities.update": {
    summary: "Update an existing entity.",
    access: "write",
  },
  "entities.delete": {
    summary: "Delete an entity, optionally cascading to descendants.",
    access: "write",
  },
  "entities.link": {
    summary: "Create a relationship between two entities.",
    access: "write",
  },
  "entities.unlink": {
    summary: "Soft-delete an entity relationship.",
    access: "write",
  },
  "entities.updateLink": {
    summary: "Update metadata / confidence on an existing relationship.",
    access: "write",
  },
  "entities.listLinks": {
    summary: "List relationships for an entity.",
    access: "read",
  },
  "entities.search": {
    summary: "Fuzzy search entities by name, optionally filtered by type.",
    access: "read",
  },

  // entitySchema
  "entitySchema.listTypes": {
    summary: "List entity types in the organization.",
    access: "read",
  },
  "entitySchema.getType": {
    summary: "Get an entity type by slug.",
    access: "read",
  },
  "entitySchema.createType": {
    summary: "Create an entity type.",
    access: "write",
  },
  "entitySchema.updateType": {
    summary: "Update an entity type.",
    access: "write",
  },
  "entitySchema.deleteType": {
    summary: "Delete an entity type.",
    access: "write",
  },
  "entitySchema.auditType": {
    summary: "List historical changes to an entity type.",
    access: "read",
  },
  "entitySchema.listRelTypes": {
    summary: "List relationship types.",
    access: "read",
  },
  "entitySchema.getRelType": {
    summary: "Get a relationship type by slug.",
    access: "read",
  },
  "entitySchema.createRelType": {
    summary: "Create a relationship type.",
    access: "write",
  },
  "entitySchema.updateRelType": {
    summary: "Update a relationship type.",
    access: "write",
  },
  "entitySchema.deleteRelType": {
    summary: "Delete a relationship type.",
    access: "write",
  },
  "entitySchema.addRule": {
    summary:
      "Add an allowed source/target entity-type rule to a relationship type.",
    access: "write",
  },
  "entitySchema.removeRule": {
    summary: "Remove a rule from a relationship type.",
    access: "write",
  },
  "entitySchema.listRules": {
    summary: "List rules attached to a relationship type.",
    access: "read",
  },

  // knowledge
  "knowledge.search": {
    summary: "Semantic + structured search over stored knowledge events.",
    access: "read",
    example:
      "const hits = await client.knowledge.search({ query: 'revenue update', limit: 10 });",
  },
  "knowledge.save": {
    summary: "Persist a knowledge event, optionally associated with entities.",
    access: "write",
  },
  "knowledge.read": {
    summary: "Read a knowledge event by id, or watcher-window context.",
    access: "read",
  },

  // watchers
  "watchers.list": {
    summary: "List watchers, optionally filtered by entity.",
    access: "read",
    example: "const ws = await client.watchers.list({ entity_id: 42 });",
  },
  "watchers.get": {
    summary: "Fetch a watcher by id.",
    access: "read",
    throws: ["WatcherNotFound"],
  },
  "watchers.create": {
    summary: "Create a watcher with prompt, extraction schema, and sources.",
    access: "write",
    throws: ["EntityNotFound", "InvalidExtractionSchema"],
  },
  "watchers.update": {
    summary: "Update watcher config (schedule, model, sources).",
    access: "write",
  },
  "watchers.delete": {
    summary: "Delete one or more watchers.",
    access: "write",
  },
  "watchers.setReactionScript": {
    summary:
      "Attach a raw TS reaction script (fires on window completion). Empty string removes it.",
    access: "write",
    throws: ["CompileError"],
  },
  "watchers.completeWindow": {
    summary:
      "Submit LLM-extracted data for a watcher window. Requires a signed window_token.",
    access: "write",
  },

  // connections
  "connections.list": {
    summary: "List configured connections in the current organization.",
    access: "read",
  },
  "connections.listConnectorDefinitions": {
    summary: "List connector definitions installed in this organization.",
    access: "read",
  },
  "connections.get": { summary: "Get a connection by id.", access: "read" },
  "connections.create": {
    summary:
      "Create a connection manually (for connectors that do not require OAuth).",
    access: "write",
  },
  "connections.connect": {
    summary:
      "Start an OAuth / auth-profile flow. Returns a connect_url to share with the user.",
    access: "write",
  },
  "connections.update": {
    summary: "Update connection config or auth profile.",
    access: "write",
  },
  "connections.delete": { summary: "Delete a connection.", access: "write" },
  "connections.test": {
    summary: "Test connection credentials (sends an external probe).",
    access: "external",
  },
  "connections.installConnector": {
    summary: "Install a connector definition into this organization.",
    access: "write",
  },
  "connections.uninstallConnector": {
    summary: "Uninstall a connector definition.",
    access: "write",
  },
  "connections.toggleConnectorLogin": {
    summary: "Enable/disable the login-with-connector flow.",
    access: "write",
  },
  "connections.updateConnectorAuth": {
    summary: "Update org-wide auth config for a connector.",
    access: "write",
  },

  // operations
  "operations.listAvailable": {
    summary: "List operations exposed by the active connections.",
    access: "read",
  },
  "operations.execute": {
    summary: "Execute a connector action. Sends an external request.",
    access: "external",
    cost: "expensive",
  },
  "operations.listRuns": {
    summary: "List past operation runs.",
    access: "read",
  },
  "operations.getRun": { summary: "Get a single run by id.", access: "read" },
  "operations.approve": {
    summary: "Approve a pending run that required human approval.",
    access: "write",
  },
  "operations.reject": {
    summary: "Reject a pending run.",
    access: "write",
  },

  // feeds
  "feeds.list": { summary: "List data-sync feeds.", access: "read" },
  "feeds.get": { summary: "Get a feed by id.", access: "read" },
  "feeds.create": {
    summary: "Create a data-sync feed for a connection.",
    access: "write",
  },
  "feeds.update": { summary: "Update a feed.", access: "write" },
  "feeds.delete": { summary: "Delete a feed.", access: "write" },
  "feeds.trigger": {
    summary: "Trigger an immediate sync for a feed (external side-effect).",
    access: "external",
  },

  // authProfiles
  "authProfiles.list": {
    summary: "List reusable auth profiles.",
    access: "read",
  },
  "authProfiles.get": {
    summary: "Get an auth profile by slug.",
    access: "read",
  },
  "authProfiles.test": {
    summary: "Test auth-profile credentials.",
    access: "external",
  },
  "authProfiles.create": {
    summary: "Create an auth profile.",
    access: "write",
  },
  "authProfiles.update": {
    summary: "Update an auth profile.",
    access: "write",
  },
  "authProfiles.delete": {
    summary: "Delete an auth profile.",
    access: "write",
  },

  // classifiers
  "classifiers.list": {
    summary: "List classifier templates.",
    access: "read",
  },
  "classifiers.create": {
    summary: "Create a classifier template.",
    access: "write",
  },
  "classifiers.createVersion": {
    summary: "Create a new version of an existing classifier.",
    access: "write",
  },
  "classifiers.getVersions": {
    summary: "List versions of a classifier.",
    access: "read",
  },
  "classifiers.setCurrentVersion": {
    summary: "Promote a version to current.",
    access: "write",
  },
  "classifiers.generateEmbeddings": {
    summary: "Generate embeddings for attribute values (cost-heavy).",
    access: "write",
    cost: "expensive",
  },
  "classifiers.delete": {
    summary: "Delete a classifier.",
    access: "write",
  },
  "classifiers.classify": {
    summary:
      "Apply a manual classification to one or many content records (single or batch).",
    access: "write",
  },

  // viewTemplates
  "viewTemplates.get": {
    summary: "Get the active view template for a resource.",
    access: "read",
  },
  "viewTemplates.set": {
    summary: "Create or update a view template.",
    access: "write",
  },
  "viewTemplates.rollback": {
    summary: "Roll back to a previous template version.",
    access: "write",
  },
  "viewTemplates.removeTab": {
    summary: "Remove a named tab from a template.",
    access: "write",
  },

  // top-level
  query: {
    summary:
      "Run a read-only SQL query against the organization-scoped virtual tables. No positional parameters — use Handlebars {{query.name}} substitutions inside the SQL when you need values.",
    access: "read",
    example:
      "const rows = await client.query(\"SELECT id, name FROM entities WHERE entity_type = 'company'\");",
  },
  log: {
    summary:
      "Emit a structured log line (captured in the invocation audit row).",
    access: "read",
    cost: "cheap",
  },
};

/** Paths that must never appear as SDK methods. Enforced by the coverage test. */
export const BANNED_PATHS = [
  "execute",
  "client.execute",
  "sdk.execute",
] as const;
