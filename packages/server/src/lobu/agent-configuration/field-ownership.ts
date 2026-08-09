import type { AgentSettings } from '@lobu/core';
import { z } from 'zod';
import type {
  AgentConfigurationRejectionReason,
  ConfigurationManagementMode,
  NativeSettingsPatch,
} from './types';

export type AgentSettingKey = Exclude<keyof AgentSettings, 'updatedAt'>;
export type AgentSettingOwner =
  | 'release'
  | 'release_legacy'
  | 'lobu_operator'
  | 'runtime'
  | 'credential';

export const AGENT_SETTING_OWNERS = {
  model: 'release_legacy',
  modelSelection: 'release',
  providerModelPreferences: 'release',
  networkConfig: 'release',
  egressConfig: 'release',
  nixConfig: 'release',
  mcpServers: 'release',
  mcpInstallNotified: 'runtime',
  soulMd: 'release',
  userMd: 'release',
  identityMd: 'release',
  skillsConfig: 'release',
  toolsConfig: 'release',
  guardrails: 'release',
  pluginsConfig: 'release',
  authProfiles: 'credential',
  installedProviders: 'release',
  verboseLogging: 'lobu_operator',
  preApprovedTools: 'release',
} as const satisfies Record<AgentSettingKey, AgentSettingOwner>;

export type NativeSettingsPatchPolicyDecision = {
  allowedFields: AgentSettingKey[];
  rejectedFields: AgentSettingKey[];
  reason: AgentConfigurationRejectionReason | null;
};

export type AgentConfigurationFieldErrorReason =
  | 'unknown_configuration_field'
  | 'runtime_field_requires_runtime_api'
  | 'credential_field_requires_credential_api'
  | 'invalid_configuration_field_value';

export class AgentConfigurationFieldError extends Error {
  constructor(readonly reason: AgentConfigurationFieldErrorReason) {
    super(reason);
    this.name = 'AgentConfigurationFieldError';
  }
}

export function ownerOfAgentSetting(key: AgentSettingKey): AgentSettingOwner {
  return AGENT_SETTING_OWNERS[key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const stringArraySchema = z.array(z.string());
const stringRecordSchema = z.record(z.string(), z.string());
const modelSelectionSchema = z
  .object({
    mode: z.enum(['auto', 'pinned']),
    pinnedModel: z.string().optional(),
  })
  .passthrough();
const domainJudgeRuleSchema = z
  .object({ domain: z.string(), judge: z.string().optional() })
  .passthrough();
const networkConfigSchema = z
  .object({
    allowedDomains: stringArraySchema.optional(),
    deniedDomains: stringArraySchema.optional(),
    judgedDomains: z.array(domainJudgeRuleSchema).optional(),
    judges: stringRecordSchema.optional(),
  })
  .passthrough();
const egressConfigSchema = z
  .object({
    extraPolicy: z.string().optional(),
    judgeModel: z.string().optional(),
  })
  .passthrough();
const nixConfigSchema = z
  .object({
    flakeUrl: z.string().optional(),
    packages: stringArraySchema.optional(),
  })
  .passthrough();
const mcpToolFilterSchema = z
  .object({
    include: stringArraySchema.optional(),
    exclude: stringArraySchema.optional(),
  })
  .passthrough();
const mcpOAuthSchema = z
  .object({
    authUrl: z.string().optional(),
    tokenUrl: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scopes: stringArraySchema.optional(),
    deviceAuthorizationUrl: z.string().optional(),
    registrationUrl: z.string().optional(),
    resource: z.string().optional(),
  })
  .passthrough();
const mcpServerSchema = z
  .object({
    url: z.string().optional(),
    type: z.enum(['sse', 'streamable-http', 'stdio']).optional(),
    command: z.string().optional(),
    args: stringArraySchema.optional(),
    env: stringRecordSchema.optional(),
    headers: stringRecordSchema.optional(),
    description: z.string().optional(),
    toolFilter: mcpToolFilterSchema.optional(),
  })
  .passthrough();
const mcpServersSchema = z.record(z.string(), mcpServerSchema);
const skillMcpServerSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    url: z.string().optional(),
    type: z.enum(['sse', 'streamable-http', 'stdio']).optional(),
    command: z.string().optional(),
    args: stringArraySchema.optional(),
    oauth: mcpOAuthSchema.optional(),
    inputs: z
      .array(
        z
          .object({
            id: z.string(),
            label: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
    headers: stringRecordSchema.optional(),
    toolFilter: mcpToolFilterSchema.optional(),
  })
  .passthrough();
const skillPreToolGuardrailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: z.string() }).passthrough(),
  z
    .object({
      kind: z.literal('judge'),
      policy: z.string(),
      tools: stringArraySchema.optional(),
    })
    .passthrough(),
]);
const skillSchema = z
  .object({
    repo: z.string(),
    name: z.string(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    enabled: z.boolean(),
    system: z.boolean().optional(),
    content: z.string().optional(),
    contentFetchedAt: z.number().optional(),
    mcpServers: z.array(skillMcpServerSchema).optional(),
    nixPackages: stringArraySchema.optional(),
    networkConfig: networkConfigSchema.optional(),
    providers: stringArraySchema.optional(),
    modelPreference: z.string().optional(),
    thinkingLevel: z.enum(['off', 'low', 'medium', 'high']).optional(),
    guardrails: z
      .object({ 'pre-tool': z.array(skillPreToolGuardrailSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const skillsConfigSchema = z.object({ skills: z.array(skillSchema) }).passthrough();
const toolsConfigSchema = z
  .object({
    allowedTools: stringArraySchema.optional(),
    deniedTools: stringArraySchema.optional(),
    strictMode: z.boolean().optional(),
    mcpExposure: z.enum(['tools', 'cli']).optional(),
  })
  .passthrough();
const pluginSchema = z
  .object({
    source: z.string(),
    slot: z.enum(['tool', 'provider', 'memory']),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const pluginsConfigSchema = z.object({ plugins: z.array(pluginSchema) }).passthrough();
const installedProviderSchema = z
  .object({
    providerId: z.string(),
    installedAt: z.number(),
    config: z
      .object({ baseUrl: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const installedProvidersSchema = z.array(installedProviderSchema);

function assertMatchesSchema<T>(
  schema: z.ZodType<T>,
  value: unknown
): asserts value is T {
  if (!schema.safeParse(value).success) {
    throw new AgentConfigurationFieldError('invalid_configuration_field_value');
  }
}

function validatedField<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null) return null;
  assertMatchesSchema(schema, value);
  return value;
}

export function parseNativeSettingsPatch(value: unknown): NativeSettingsPatch {
  if (!isPlainObject(value)) {
    throw new AgentConfigurationFieldError('unknown_configuration_field');
  }

  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(AGENT_SETTING_OWNERS, key)) {
      throw new AgentConfigurationFieldError('unknown_configuration_field');
    }
    const owner = AGENT_SETTING_OWNERS[key as AgentSettingKey];
    if (owner === 'runtime') {
      throw new AgentConfigurationFieldError('runtime_field_requires_runtime_api');
    }
    if (owner === 'credential') {
      throw new AgentConfigurationFieldError('credential_field_requires_credential_api');
    }
  }

  const patch: NativeSettingsPatch = {};
  if (Object.hasOwn(value, 'model')) {
    patch.model = validatedField(z.string(), value.model);
  }
  if (Object.hasOwn(value, 'modelSelection')) {
    patch.modelSelection = validatedField(modelSelectionSchema, value.modelSelection);
  }
  if (Object.hasOwn(value, 'providerModelPreferences')) {
    patch.providerModelPreferences = validatedField(
      stringRecordSchema,
      value.providerModelPreferences
    );
  }
  if (Object.hasOwn(value, 'networkConfig')) {
    patch.networkConfig = validatedField(networkConfigSchema, value.networkConfig);
  }
  if (Object.hasOwn(value, 'egressConfig')) {
    patch.egressConfig = validatedField(egressConfigSchema, value.egressConfig);
  }
  if (Object.hasOwn(value, 'nixConfig')) {
    patch.nixConfig = validatedField(nixConfigSchema, value.nixConfig);
  }
  if (Object.hasOwn(value, 'mcpServers')) {
    patch.mcpServers = validatedField(mcpServersSchema, value.mcpServers);
  }
  if (Object.hasOwn(value, 'soulMd')) {
    patch.soulMd = validatedField(z.string(), value.soulMd);
  }
  if (Object.hasOwn(value, 'userMd')) {
    patch.userMd = validatedField(z.string(), value.userMd);
  }
  if (Object.hasOwn(value, 'identityMd')) {
    patch.identityMd = validatedField(z.string(), value.identityMd);
  }
  if (Object.hasOwn(value, 'skillsConfig')) {
    patch.skillsConfig = validatedField(skillsConfigSchema, value.skillsConfig);
  }
  if (Object.hasOwn(value, 'toolsConfig')) {
    patch.toolsConfig = validatedField(toolsConfigSchema, value.toolsConfig);
  }
  if (Object.hasOwn(value, 'pluginsConfig')) {
    patch.pluginsConfig = validatedField(pluginsConfigSchema, value.pluginsConfig);
  }
  if (Object.hasOwn(value, 'installedProviders')) {
    patch.installedProviders = validatedField(
      installedProvidersSchema,
      value.installedProviders
    );
  }
  if (Object.hasOwn(value, 'verboseLogging')) {
    patch.verboseLogging = validatedField(z.boolean(), value.verboseLogging);
  }
  if (Object.hasOwn(value, 'preApprovedTools')) {
    patch.preApprovedTools = validatedField(stringArraySchema, value.preApprovedTools);
  }
  if (Object.hasOwn(value, 'guardrails')) {
    patch.guardrails = validatedField(stringArraySchema, value.guardrails);
  }
  return patch;
}

export function normalizeNativeSettingsPatchForPersistence(
  patch: NativeSettingsPatch
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(patch)) {
    switch (key) {
      case 'model':
        normalized[key] = fieldValue ?? null;
        break;
      case 'modelSelection':
      case 'providerModelPreferences':
      case 'networkConfig':
      case 'egressConfig':
      case 'nixConfig':
      case 'mcpServers':
      case 'toolsConfig':
      case 'pluginsConfig':
        normalized[key] = fieldValue ?? {};
        break;
      case 'soulMd':
      case 'userMd':
      case 'identityMd':
        normalized[key] = fieldValue ?? '';
        break;
      case 'skillsConfig':
        normalized[key] = fieldValue ?? { skills: [] };
        break;
      case 'installedProviders':
      case 'preApprovedTools':
      case 'guardrails':
        normalized[key] = fieldValue ?? [];
        break;
      case 'verboseLogging':
        normalized[key] = fieldValue ?? false;
        break;
      default:
        throw new AgentConfigurationFieldError('unknown_configuration_field');
    }
  }
  return normalized;
}

export function decideNativeSettingsPatch(
  managementMode: ConfigurationManagementMode,
  patch: NativeSettingsPatch
): NativeSettingsPatchPolicyDecision {
  const fields = Object.keys(patch) as AgentSettingKey[];
  if (managementMode === 'native') {
    return { allowedFields: fields, rejectedFields: [], reason: null };
  }

  const rejectedFields = fields.filter((field) => {
    const owner = ownerOfAgentSetting(field);
    return owner === 'release' || owner === 'release_legacy';
  });
  return {
    allowedFields: fields.filter((field) => !rejectedFields.includes(field)),
    rejectedFields,
    reason: rejectedFields.length > 0 ? 'field_owned_by_managed_release' : null,
  };
}
