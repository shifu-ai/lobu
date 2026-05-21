/**
 * Declarative authoring API. Each `define*` returns a branded plain object that
 * doubles as a typed handle (e.g. an {@link EntityType} can be passed to
 * {@link defineRelationshipType}, an {@link Agent} to {@link defineWatcher}).
 *
 * These are pure data producers with no side effects — `lobu apply` imports the
 * entrypoint, reads the {@link Project} default export, and maps it to the
 * server's desired state. Executable handlers (connector `sync`/`execute`,
 * watcher reactions) live in their own modules; these objects only declare
 * config and references.
 */

import type { ConnectorClass } from "@lobu/connector-sdk";
import type { SecretRef } from "./secret.js";

/** A connector referenced by its key, or by the class produced by `defineConnector`. */
export type ConnectorRef = string | ConnectorClass;

// ---------------------------------------------------------------------------
// Memory schema
// ---------------------------------------------------------------------------

export interface EntityType {
  readonly kind: "entityType";
  /** Stable slug — diff key. */
  key: string;
  name?: string;
  description?: string;
  /** Required property names for the entity's metadata. */
  required?: string[];
  /** JSON Schema properties for the entity's metadata. */
  properties?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function defineEntityType(config: Omit<EntityType, "kind">): EntityType {
  return { kind: "entityType", ...config };
}

export interface RelationshipType {
  readonly kind: "relationshipType";
  key: string;
  name?: string;
  description?: string;
  /** Allowed source/target entity types (handle or slug). */
  rules?: Array<{ source: EntityType | string; target: EntityType | string }>;
  metadata?: Record<string, unknown>;
}

export function defineRelationshipType(
  config: Omit<RelationshipType, "kind">
): RelationshipType {
  return { kind: "relationshipType", ...config };
}

// ---------------------------------------------------------------------------
// Connections & auth profiles (code declares wiring; the UI performs OAuth)
// ---------------------------------------------------------------------------

export type AuthProfileKind =
  | "env"
  | "oauth_app"
  | "oauth_account"
  | "browser_session";

export interface AuthProfile {
  readonly kind: "authProfile";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  authKind: AuthProfileKind;
  name?: string;
  /**
   * Credential references. Values are `secret(...)` refs (or literal `$VAR`
   * strings). Only meaningful for `env` / `oauth_app`; the OAuth grant for
   * `oauth_account` / `browser_session` is performed at runtime in the UI.
   */
  credentials?: Record<string, string | SecretRef>;
}

export function defineAuthProfile(
  config: Omit<AuthProfile, "kind">
): AuthProfile {
  return { kind: "authProfile", ...config };
}

export interface ConnectionFeed {
  /** Feed key from the connector definition. */
  feed: string;
  name?: string;
  schedule?: string;
  config?: Record<string, unknown>;
}

export interface Connection {
  readonly kind: "connection";
  /** Stable slug — diff key. */
  slug: string;
  connector: ConnectorRef;
  name?: string;
  /** Runtime/account auth profile (handle or slug). */
  authProfile?: AuthProfile | string;
  /** OAuth-app auth profile (handle or slug). */
  appAuthProfile?: AuthProfile | string;
  config?: Record<string, unknown>;
  /** UUID pinning syncs/actions to a specific device worker. */
  deviceWorkerId?: string;
  feeds?: ConnectionFeed[];
}

export function defineConnection(config: Omit<Connection, "kind">): Connection {
  return { kind: "connection", ...config };
}

// ---------------------------------------------------------------------------
// Watchers (reaction handlers are wired in a later slice)
// ---------------------------------------------------------------------------

export interface WatcherNotification {
  channel?: "canvas" | "notification" | "both";
  priority?: "low" | "normal" | "high";
}

export interface Watcher {
  readonly kind: "watcher";
  /** Stable slug — diff key. */
  slug: string;
  /** Owning agent (handle or id). Every watcher belongs to exactly one agent. */
  agent: Agent | string;
  name?: string;
  description?: string;
  schedule?: string;
  prompt: string;
  /** JSON Schema (or TypeBox schema) describing the LLM output. */
  extractionSchema: Record<string, unknown>;
  /** Named SQL data sources (`name` -> query). */
  sources?: Record<string, string>;
  notification?: WatcherNotification;
  minCooldownSeconds?: number;
  tags?: string[];
}

export function defineWatcher(config: Omit<Watcher, "kind">): Watcher {
  return { kind: "watcher", ...config };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  id?: string;
  model: string;
  key?: string | SecretRef;
}

export interface NetworkConfig {
  allowed?: string[];
  denied?: string[];
}

export interface Agent {
  readonly kind: "agent";
  id: string;
  name?: string;
  description?: string;
  providers?: ProviderConfig[];
  network?: NetworkConfig;
  /** Connections this agent uses (handle or slug). */
  connections?: Array<Connection | string>;
  schema?: {
    entities?: EntityType[];
    relationships?: RelationshipType[];
  };
}

export function defineAgent(config: Omit<Agent, "kind">): Agent {
  return { kind: "agent", ...config };
}

// ---------------------------------------------------------------------------
// Project (default export of lobu.config.ts)
// ---------------------------------------------------------------------------

export interface Project {
  readonly kind: "project";
  /** Lobu Cloud org slug this project applies to. */
  org?: string;
  agents: Agent[];
  entities?: EntityType[];
  relationships?: RelationshipType[];
  connections?: Connection[];
  authProfiles?: AuthProfile[];
  watchers?: Watcher[];
}

export function defineConfig(config: Omit<Project, "kind">): Project {
  return { kind: "project", ...config };
}
