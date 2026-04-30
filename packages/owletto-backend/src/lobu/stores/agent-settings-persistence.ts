import type { AgentSettings } from '@lobu/core';
import type { DbClient } from '../../db/client';

export interface AgentSettingsContext {
  localSettings: AgentSettings | null;
  effectiveSettings: AgentSettings | null;
  templateAgentId?: string;
}

export interface AgentSettingsPersistenceOptions {
  /** Omit DB defaults so template fallback can distinguish unset from override. */
  omitEmptyDefaults?: boolean;
  /** Include host-owned columns round-tripped by the embedded Lobu store. */
  includeHostFields?: boolean;
}

type AgentSettingsKey = Extract<keyof AgentSettings, string>;
type RowMapping = readonly [AgentSettingsKey, string];
type PersistedColumn = {
  column: string;
  jsonb?: boolean;
  save: (settings: Omit<AgentSettings, 'updatedAt'>) => unknown;
  reset: unknown;
};

const SETTINGS_COLUMNS = [
  'model',
  'model_selection',
  'provider_model_preferences',
  'network_config',
  'egress_config',
  'nix_config',
  'mcp_servers',
  'mcp_install_notified',
  'soul_md',
  'user_md',
  'identity_md',
  'skills_config',
  'tools_config',
  'plugins_config',
  'auth_profiles',
  'installed_providers',
  'verbose_logging',
  'template_agent_id',
  'pre_approved_tools',
  'guardrails',
  'updated_at',
] as const;

const JSON_ROW_FIELDS: RowMapping[] = [
  ['modelSelection', 'model_selection'],
  ['providerModelPreferences', 'provider_model_preferences'],
  ['networkConfig', 'network_config'],
  ['nixConfig', 'nix_config'],
  ['mcpServers', 'mcp_servers'],
  ['mcpInstallNotified', 'mcp_install_notified'],
  ['toolsConfig', 'tools_config'],
  ['pluginsConfig', 'plugins_config'],
  ['authProfiles', 'auth_profiles'],
  ['installedProviders', 'installed_providers'],
];

const HOST_JSON_ROW_FIELDS: RowMapping[] = [
  ['egressConfig', 'egress_config'],
  ['preApprovedTools', 'pre_approved_tools'],
  ['guardrails', 'guardrails'],
];

const STRING_ROW_FIELDS: RowMapping[] = [
  ['soulMd', 'soul_md'],
  ['userMd', 'user_md'],
  ['identityMd', 'identity_md'],
];

const BASE_PERSISTED_COLUMNS: PersistedColumn[] = [
  { column: 'model', save: (s) => s.model ?? null, reset: null },
  { column: 'model_selection', jsonb: true, save: (s) => s.modelSelection ?? {}, reset: {} },
  {
    column: 'provider_model_preferences',
    jsonb: true,
    save: (s) => s.providerModelPreferences ?? {},
    reset: {},
  },
  { column: 'network_config', jsonb: true, save: (s) => s.networkConfig ?? {}, reset: {} },
  { column: 'nix_config', jsonb: true, save: (s) => s.nixConfig ?? {}, reset: {} },
  { column: 'mcp_servers', jsonb: true, save: (s) => s.mcpServers ?? {}, reset: {} },
  {
    column: 'mcp_install_notified',
    jsonb: true,
    save: (s) => s.mcpInstallNotified ?? {},
    reset: {},
  },
  { column: 'soul_md', save: (s) => s.soulMd ?? '', reset: '' },
  { column: 'user_md', save: (s) => s.userMd ?? '', reset: '' },
  { column: 'identity_md', save: (s) => s.identityMd ?? '', reset: '' },
  {
    column: 'skills_config',
    jsonb: true,
    save: (s) => s.skillsConfig ?? { skills: [] },
    reset: { skills: [] },
  },
  { column: 'tools_config', jsonb: true, save: (s) => s.toolsConfig ?? {}, reset: {} },
  { column: 'plugins_config', jsonb: true, save: (s) => s.pluginsConfig ?? {}, reset: {} },
  { column: 'auth_profiles', jsonb: true, save: (s) => s.authProfiles ?? [], reset: [] },
  {
    column: 'installed_providers',
    jsonb: true,
    save: (s) => s.installedProviders ?? [],
    reset: [],
  },
  { column: 'verbose_logging', save: (s) => s.verboseLogging ?? false, reset: false },
  { column: 'template_agent_id', save: (s) => s.templateAgentId ?? null, reset: null },
];

const HOST_PERSISTED_COLUMNS: PersistedColumn[] = [
  { column: 'egress_config', jsonb: true, save: (s) => s.egressConfig ?? {}, reset: {} },
  { column: 'pre_approved_tools', jsonb: true, save: (s) => s.preApprovedTools ?? [], reset: [] },
  { column: 'guardrails', jsonb: true, save: (s) => s.guardrails ?? [], reset: [] },
];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonEmptyObject(value: unknown): unknown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value : undefined;
  return Object.keys(value as Record<string, unknown>).length > 0 ? value : undefined;
}

function maybeDefault(value: unknown, options: AgentSettingsPersistenceOptions): unknown | undefined {
  return options.omitEmptyDefaults ? nonEmptyObject(value) : (value ?? undefined);
}

function maybeString(value: unknown, options: AgentSettingsPersistenceOptions): string | undefined {
  return options.omitEmptyDefaults ? nonEmptyString(value) : ((value as string | null) ?? undefined);
}

function setIfDefined(out: AgentSettings, key: AgentSettingsKey, value: unknown): void {
  if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
}

export function agentSettingsWithDefinedValues(settings: AgentSettings): Partial<AgentSettings> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, field]) => field !== undefined)
  ) as Partial<AgentSettings>;
}

export function rowToAgentSettings(
  row: Record<string, any>,
  options: AgentSettingsPersistenceOptions = {}
): AgentSettings {
  const out: AgentSettings = {
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : (row.updated_at ?? Date.now()),
  };

  if (row.model != null) out.model = row.model;
  for (const [key, column] of JSON_ROW_FIELDS) setIfDefined(out, key, maybeDefault(row[column], options));
  if (options.includeHostFields) {
    for (const [key, column] of HOST_JSON_ROW_FIELDS) setIfDefined(out, key, maybeDefault(row[column], options));
  }
  for (const [key, column] of STRING_ROW_FIELDS) setIfDefined(out, key, maybeString(row[column], options));

  const skillsConfig = row.skills_config;
  if (
    options.omitEmptyDefaults &&
    skillsConfig &&
    Array.isArray(skillsConfig.skills) &&
    skillsConfig.skills.length === 0
  ) {
    // Treat `{ skills: [] }` as "not set" so template skills can inherit.
  } else if (skillsConfig !== undefined && skillsConfig !== null) {
    out.skillsConfig = skillsConfig;
  }

  if (row.verbose_logging) out.verboseLogging = true;
  if (row.template_agent_id) out.templateAgentId = row.template_agent_id;
  return out;
}

function persistedColumns(options: AgentSettingsPersistenceOptions): PersistedColumn[] {
  return options.includeHostFields
    ? [...BASE_PERSISTED_COLUMNS, ...HOST_PERSISTED_COLUMNS]
    : BASE_PERSISTED_COLUMNS;
}

function buildWhere(values: unknown[], agentId: string, orgId: string | null | undefined): string {
  values.push(agentId);
  let where = `id = $${values.length}`;
  if (orgId) {
    values.push(orgId);
    where += ` AND organization_id = $${values.length}`;
  }
  return where;
}

async function updateAgentSettingsRow(
  sql: DbClient,
  agentId: string,
  orgId: string | null | undefined,
  columns: PersistedColumn[],
  getValue: (column: PersistedColumn) => unknown
): Promise<void> {
  const values: unknown[] = [];
  const assignments = columns.map((column) => {
    values.push(column.jsonb ? JSON.stringify(getValue(column)) : getValue(column));
    return `${column.column} = $${values.length}${column.jsonb ? '::jsonb' : ''}`;
  });
  values.push(new Date());
  assignments.push(`updated_at = $${values.length}`);

  const where = buildWhere(values, agentId, orgId);
  await sql.unsafe(`UPDATE agents SET ${assignments.join(', ')} WHERE ${where}`, values);
}

export async function loadAgentSettingsFromPg(
  sql: DbClient,
  agentId: string,
  orgId: string | null | undefined,
  options: AgentSettingsPersistenceOptions = {}
): Promise<AgentSettings | null> {
  const values: unknown[] = [];
  const where = buildWhere(values, agentId, orgId);
  const rows = await sql.unsafe<Record<string, any>>(
    `SELECT ${SETTINGS_COLUMNS.join(', ')} FROM agents WHERE ${where}`,
    values
  );
  return rows.length === 0 ? null : rowToAgentSettings(rows[0], options);
}

export async function saveAgentSettingsToPg(
  sql: DbClient,
  agentId: string,
  settings: Omit<AgentSettings, 'updatedAt'>,
  orgId: string | null | undefined,
  options: AgentSettingsPersistenceOptions = {}
): Promise<void> {
  await updateAgentSettingsRow(sql, agentId, orgId, persistedColumns(options), (column) =>
    column.save(settings)
  );
}

export async function deleteAgentSettingsFromPg(
  sql: DbClient,
  agentId: string,
  orgId: string | null | undefined,
  options: AgentSettingsPersistenceOptions = {}
): Promise<void> {
  await updateAgentSettingsRow(sql, agentId, orgId, persistedColumns(options), (column) =>
    column.reset
  );
}
