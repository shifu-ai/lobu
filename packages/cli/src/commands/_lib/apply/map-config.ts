/**
 * Map a `@lobu/sdk` authoring project (the default export of `lobu.config.ts`,
 * built by `defineConfig`) to the apply `DesiredState`.
 *
 * `DesiredState` is an apply-internal IR and stays CLI-private; this is the one
 * place that translates the public authoring objects into it. The mapping is
 * pure (modulo `installedAt` timestamps, matching the TOML loader) so it can be
 * unit-tested without importing `lobu.config.ts`.
 */

import type { AgentSettings } from "@lobu/core";
import type {
  Agent,
  AuthProfile,
  Connection,
  ConnectorRef,
  EntityType,
  ProviderConfig,
  Project,
  RelationshipType,
  Watcher,
} from "@lobu/sdk";
import { isSecretRef } from "@lobu/sdk";
import { ValidationError } from "../../memory/_lib/errors.js";
import type {
  DesiredAgent,
  DesiredAgentMetadata,
  DesiredAuthProfile,
  DesiredConnection,
  DesiredEntityType,
  DesiredFeed,
  DesiredRelationshipType,
  DesiredState,
  DesiredWatcher,
} from "./desired-state.js";

/** Source label recorded on connector docs (mirrors the YAML manifest path). */
const CONFIG_SOURCE = "lobu.config.ts";

/** `"$NAME"` → `"NAME"`, else null. Mirrors the TOML loader's env-ref detection. */
function envRefName(value: string): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
  return match ? (match[1] ?? null) : null;
}

/** Provider id used as the storage key; falls back to the model when omitted. */
function providerId(provider: ProviderConfig): string {
  return provider.id ?? provider.model;
}

/** Resolve a connector reference (key string, or the class from `defineConnector`) to its key. */
function connectorKey(ref: ConnectorRef): string {
  if (typeof ref === "string") return ref;
  return new ref().definition.key;
}

function entitySlug(ref: EntityType | string): string {
  return typeof ref === "string" ? ref : ref.key;
}

function agentId(ref: Agent | string): string {
  return typeof ref === "string" ? ref : ref.id;
}

function authProfileSlug(
  ref: AuthProfile | string | undefined
): string | undefined {
  if (ref === undefined) return undefined;
  return typeof ref === "string" ? ref : ref.slug;
}

/** Credential value → `$VAR` string; collects the referenced secret name. */
function credentialString(
  value: string | { readonly $secret: string },
  required: Set<string>
): string {
  if (isSecretRef(value)) {
    required.add(value.$secret);
    return `$${value.$secret}`;
  }
  const ref = envRefName(value);
  if (ref) required.add(ref);
  return value;
}

function mapAgent(
  agent: Agent,
  env: NodeJS.ProcessEnv,
  required: Set<string>
): DesiredAgent {
  const settings: Partial<AgentSettings> = {};

  if (agent.providers?.length) {
    settings.installedProviders = agent.providers.map((p) => ({
      providerId: providerId(p),
      installedAt: Date.now(),
    }));
    settings.modelSelection = { mode: "auto" };
    const preferences = Object.fromEntries(
      agent.providers
        .filter((p) => !!p.model?.trim())
        .map((p) => [providerId(p), p.model.trim()])
    );
    if (Object.keys(preferences).length > 0) {
      settings.providerModelPreferences = preferences;
    }
  }

  const allowed = agent.network?.allowed ?? [];
  const denied = agent.network?.denied ?? [];
  if (allowed.length > 0 || denied.length > 0) {
    settings.networkConfig = {
      ...(allowed.length > 0 ? { allowedDomains: [...new Set(allowed)] } : {}),
      ...(denied.length > 0 ? { deniedDomains: [...new Set(denied)] } : {}),
    };
  }

  const providerKeys: { providerId: string; value: string }[] = [];
  for (const provider of agent.providers ?? []) {
    if (provider.key === undefined) continue;
    if (isSecretRef(provider.key)) {
      required.add(provider.key.$secret);
      const value = env[provider.key.$secret];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    const ref = envRefName(provider.key);
    if (ref) {
      required.add(ref);
      const value = env[ref];
      if (value) providerKeys.push({ providerId: providerId(provider), value });
      continue;
    }
    providerKeys.push({
      providerId: providerId(provider),
      value: provider.key,
    });
  }

  const metadata: DesiredAgentMetadata = {
    agentId: agent.id,
    name: agent.name ?? agent.id,
  };
  if (agent.description) metadata.description = agent.description;

  return { metadata, settings, platforms: [], providerKeys };
}

function mapEntityType(entity: EntityType): DesiredEntityType {
  return {
    slug: entity.key,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.description ? { description: entity.description } : {}),
    ...(entity.required ? { required: entity.required } : {}),
    ...(entity.properties ? { properties: entity.properties } : {}),
    ...(entity.metadata ? { metadata: entity.metadata } : {}),
  };
}

function mapRelationshipType(rel: RelationshipType): DesiredRelationshipType {
  return {
    slug: rel.key,
    ...(rel.name ? { name: rel.name } : {}),
    ...(rel.description ? { description: rel.description } : {}),
    ...(rel.rules
      ? {
          rules: rel.rules.map((rule) => ({
            source: entitySlug(rule.source),
            target: entitySlug(rule.target),
          })),
        }
      : {}),
    ...(rel.metadata ? { metadata: rel.metadata } : {}),
  };
}

function mapWatcher(watcher: Watcher): DesiredWatcher {
  const sources = watcher.sources
    ? Object.entries(watcher.sources).map(([name, query]) => ({ name, query }))
    : undefined;
  return {
    slug: watcher.slug,
    agent: agentId(watcher.agent),
    prompt: watcher.prompt,
    extractionSchema: watcher.extractionSchema,
    ...(watcher.name ? { name: watcher.name } : {}),
    ...(watcher.description ? { description: watcher.description } : {}),
    ...(watcher.schedule ? { schedule: watcher.schedule } : {}),
    ...(sources ? { sources } : {}),
    ...(watcher.notification?.channel
      ? { notificationChannel: watcher.notification.channel }
      : {}),
    ...(watcher.notification?.priority
      ? { notificationPriority: watcher.notification.priority }
      : {}),
    ...(watcher.minCooldownSeconds !== undefined
      ? { minCooldownSeconds: watcher.minCooldownSeconds }
      : {}),
    ...(watcher.tags ? { tags: watcher.tags } : {}),
  };
}

function mapAuthProfile(
  profile: AuthProfile,
  required: Set<string>
): DesiredAuthProfile {
  const credentials = profile.credentials
    ? Object.fromEntries(
        Object.entries(profile.credentials).map(([key, value]) => [
          key,
          credentialString(value, required),
        ])
      )
    : undefined;
  return {
    slug: profile.slug,
    connector: connectorKey(profile.connector),
    kind: profile.authKind,
    sourceFile: CONFIG_SOURCE,
    ...(profile.name ? { name: profile.name } : {}),
    ...(credentials ? { credentials } : {}),
  };
}

function mapConnection(connection: Connection): DesiredConnection {
  const feeds: DesiredFeed[] = (connection.feeds ?? []).map((feed) => ({
    feedKey: feed.feed,
    ...(feed.name ? { name: feed.name } : {}),
    ...(feed.schedule ? { schedule: feed.schedule } : {}),
    ...(feed.config ? { config: feed.config } : {}),
  }));
  const authSlug = authProfileSlug(connection.authProfile);
  const appAuthSlug = authProfileSlug(connection.appAuthProfile);
  return {
    slug: connection.slug,
    connector: connectorKey(connection.connector),
    feeds,
    sourceFile: CONFIG_SOURCE,
    ...(connection.name ? { name: connection.name } : {}),
    ...(authSlug ? { authProfileSlug: authSlug } : {}),
    ...(appAuthSlug ? { appAuthProfileSlug: appAuthSlug } : {}),
    ...(connection.config ? { config: connection.config } : {}),
    ...(connection.deviceWorkerId
      ? { deviceWorkerId: connection.deviceWorkerId }
      : {}),
  };
}

/** Translate a `@lobu/sdk` project into the apply `DesiredState`. */
export function mapProjectToDesiredState(
  project: Project,
  env: NodeJS.ProcessEnv = process.env
): DesiredState {
  const required = new Set<string>();

  const agents = project.agents.map((agent) => mapAgent(agent, env, required));
  const entityTypes = (project.entities ?? []).map(mapEntityType);
  const relationshipTypes = (project.relationships ?? []).map(
    mapRelationshipType
  );
  const watchers = (project.watchers ?? []).map(mapWatcher);
  const authProfiles = (project.authProfiles ?? []).map((profile) =>
    mapAuthProfile(profile, required)
  );
  const connections = (project.connections ?? []).map(mapConnection);

  const agentIds = new Set(project.agents.map((agent) => agent.id));
  for (const watcher of watchers) {
    if (!agentIds.has(watcher.agent)) {
      throw new ValidationError(
        `watcher "${watcher.slug}" names agent "${watcher.agent}", but no agent with that id is declared in lobu.config.ts`
      );
    }
  }

  return {
    agents,
    ...(project.org ? { memory: { org: project.org } } : {}),
    memorySchema: { entityTypes, relationshipTypes },
    watchers,
    connectors: { definitions: [], authProfiles, connections },
    requiredSecrets: [...required].sort(),
  };
}
