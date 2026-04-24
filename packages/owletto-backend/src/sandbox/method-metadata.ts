/**
 * ClientSDK method metadata.
 *
 * Describes each SDK method for:
 * - `search` MCP tool (summary, example, throws)
 * - Dry-run classification (read | write | external) — PR-2 wires this into the wrapper
 * - Static bans (e.g. `client.execute` must not be exposed recursively)
 *
 * Keyed by dotted SDK path (e.g. `watchers.list`, `entities.create`).
 * Populated incrementally — PR-1 seeds the shape + a handful of examples.
 * PR-2 validates coverage against the runtime dispatch table in CI.
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

/**
 * Metadata entries. Keys are dotted SDK paths.
 *
 * This table is intentionally sparse in PR-1 — PR-2 fills it to 100% coverage
 * and adds a CI test that fails if a new SDK method ships without metadata.
 */
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
    summary: "Delete an entity.",
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
  "entities.search": {
    summary: "Search entities by name / metadata.",
    access: "read",
  },

  // knowledge
  "knowledge.search": {
    summary: "Semantic search over stored knowledge events.",
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
    summary: "Update watcher config (model, schedule, sources).",
    access: "write",
  },
  "watchers.delete": {
    summary: "Delete a watcher.",
    access: "write",
  },
  "watchers.setReactionScript": {
    summary: "Attach a raw TS reaction script that fires on window completion.",
    access: "write",
    throws: ["CompileError"],
  },

  // connections (external side effects for execute)
  "connections.list": {
    summary: "List configured connections in the current organization.",
    access: "read",
  },
  "connections.get": { summary: "Get a connection by id.", access: "read" },
  "connections.create": {
    summary: "Create a new connection.",
    access: "write",
  },
  "connections.connect": {
    summary:
      "Start an OAuth flow. Returns a connect_url to share with the user.",
    access: "write",
  },
  "connections.update": {
    summary: "Update connection config.",
    access: "write",
  },
  "connections.delete": { summary: "Delete a connection.", access: "write" },
  "connections.test": {
    summary: "Test connection credentials.",
    access: "external",
  },

  // operations (run external actions)
  "operations.listAvailable": {
    summary: "List operations exposed by the active connections.",
    access: "read",
  },
  "operations.execute": {
    summary: "Execute a connector action. Sends an external request.",
    access: "external",
    cost: "expensive",
  },

  // feeds
  "feeds.list": { summary: "List data-sync feeds.", access: "read" },
  "feeds.get": { summary: "Get a feed by id.", access: "read" },
  "feeds.create": { summary: "Create a data-sync feed.", access: "write" },
  "feeds.update": { summary: "Update a feed.", access: "write" },
  "feeds.delete": { summary: "Delete a feed.", access: "write" },
  "feeds.trigger": {
    summary: "Trigger an immediate sync for a feed.",
    access: "external",
  },

  // authProfiles
  "authProfiles.list": {
    summary: "List reusable auth profiles.",
    access: "read",
  },
  "authProfiles.get": { summary: "Get an auth profile by id.", access: "read" },
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
  "authProfiles.test": {
    summary: "Test auth profile credentials.",
    access: "external",
  },

  // classifiers
  "classifiers.list": { summary: "List classifier templates.", access: "read" },
  "classifiers.create": {
    summary: "Create a classifier template.",
    access: "write",
  },
  "classifiers.delete": {
    summary: "Delete a classifier template.",
    access: "write",
  },
  "classifiers.classify": {
    summary: "Classify one or many content strings.",
    access: "read",
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
  "entitySchema.listRelTypes": {
    summary: "List relationship types.",
    access: "read",
  },
  "entitySchema.createRelType": {
    summary: "Create a relationship type.",
    access: "write",
  },

  // top-level
  query: {
    summary:
      "Run a read-only SQL query against the organization-scoped virtual tables.",
    access: "read",
    example:
      'const rows = await client.query("SELECT * FROM entities WHERE entity_type = $1", ["company"]);',
  },
  log: {
    summary:
      "Emit a structured log line (captured in the invocation audit row).",
    access: "read",
    cost: "cheap",
  },
};

/** Paths that must never appear as SDK methods. Enforced in PR-2 tests. */
export const BANNED_PATHS = [
  "execute",
  "client.execute",
  "sdk.execute",
] as const;
