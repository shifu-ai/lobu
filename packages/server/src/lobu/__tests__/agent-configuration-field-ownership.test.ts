import { describe, expect, test } from 'bun:test';
import {
  AGENT_SETTING_OWNERS,
  decideNativeSettingsPatch,
  ownerOfAgentSetting,
  parseNativeSettingsPatch,
} from '../agent-configuration/field-ownership';

describe('agent configuration field ownership', () => {
  test('classifies every current AgentSettings field except updatedAt', () => {
    expect(AGENT_SETTING_OWNERS).toEqual({
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
    });
    expect(ownerOfAgentSetting('identityMd')).toBe('release');
    expect(ownerOfAgentSetting('verboseLogging')).toBe('lobu_operator');
    expect(ownerOfAgentSetting('mcpInstallNotified')).toBe('runtime');
    expect(ownerOfAgentSetting('authProfiles')).toBe('credential');
  });

  test('parses registered native patches without changing nested values', () => {
    const nested = { example: { url: 'https://mcp.example' } };
    const parsed = parseNativeSettingsPatch({ mcpServers: nested, verboseLogging: true });

    expect(parsed).toEqual({ mcpServers: nested, verboseLogging: true });
    expect(parsed.mcpServers).toBe(nested);
  });

  test('rejects unknown, timestamp, runtime, and credential fields closed', () => {
    expect(() => parseNativeSettingsPatch({ futureField: true })).toThrow(
      'unknown_configuration_field'
    );
    expect(() => parseNativeSettingsPatch({ updatedAt: 1 })).toThrow(
      'unknown_configuration_field'
    );
    expect(() => parseNativeSettingsPatch({ mcpInstallNotified: {} })).toThrow(
      'runtime_field_requires_runtime_api'
    );
    expect(() => parseNativeSettingsPatch({ authProfiles: [] })).toThrow(
      'credential_field_requires_credential_api'
    );
  });

  test('accepts only plain objects', () => {
    expect(() => parseNativeSettingsPatch(null)).toThrow('unknown_configuration_field');
    expect(() => parseNativeSettingsPatch([])).toThrow('unknown_configuration_field');
    expect(() => parseNativeSettingsPatch(new (class Patch {})())).toThrow(
      'unknown_configuration_field'
    );
  });

  test.each([
    ['model', 42],
    ['modelSelection', []],
    ['providerModelPreferences', []],
    ['networkConfig', []],
    ['egressConfig', []],
    ['nixConfig', []],
    ['mcpServers', 'broken'],
    ['soulMd', 42],
    ['userMd', 42],
    ['identityMd', 42],
    ['skillsConfig', []],
    ['toolsConfig', []],
    ['pluginsConfig', []],
    ['installedProviders', {}],
    ['verboseLogging', 'yes'],
    ['preApprovedTools', {}],
    ['guardrails', {}],
  ])('rejects malformed outer shape for %s', (field, value) => {
    expect(() => parseNativeSettingsPatch({ [field]: value })).toThrow(
      'invalid_configuration_field_value'
    );
  });

  test.each([
    ['modelSelection', { mode: null }],
    ['providerModelPreferences', { openai: null }],
    ['mcpServers', { broken: null }],
    ['skillsConfig', { skills: null }],
    ['installedProviders', [null]],
    ['preApprovedTools', [null]],
    ['guardrails', [null]],
  ])('rejects invalid nested nulls for %s', (field, value) => {
    expect(() => parseNativeSettingsPatch({ [field]: value })).toThrow(
      'invalid_configuration_field_value'
    );
  });

  test('preserves explicit null reset markers for persistence normalization', () => {
    expect(
      parseNativeSettingsPatch({
        model: null,
        modelSelection: null,
        providerModelPreferences: null,
        networkConfig: null,
        egressConfig: null,
        nixConfig: null,
        mcpServers: null,
        soulMd: null,
        userMd: null,
        identityMd: null,
        skillsConfig: null,
        toolsConfig: null,
        pluginsConfig: null,
        installedProviders: null,
        verboseLogging: null,
        preApprovedTools: null,
        guardrails: null,
      })
    ).toEqual({
      model: null,
      modelSelection: null,
      providerModelPreferences: null,
      networkConfig: null,
      egressConfig: null,
      nixConfig: null,
      mcpServers: null,
      soulMd: null,
      userMd: null,
      identityMd: null,
      skillsConfig: null,
      toolsConfig: null,
      pluginsConfig: null,
      installedProviders: null,
      verboseLogging: null,
      preApprovedTools: null,
      guardrails: null,
    });
  });

  test('returns pure policy decisions for native and managed targets', () => {
    expect(
      decideNativeSettingsPatch('native', {
        identityMd: 'identity',
        model: 'legacy-model',
        verboseLogging: true,
      })
    ).toEqual({
      allowedFields: ['identityMd', 'model', 'verboseLogging'],
      rejectedFields: [],
      reason: null,
    });
    expect(
      decideNativeSettingsPatch('toolbox_managed', {
        identityMd: 'identity',
        model: 'legacy-model',
        verboseLogging: true,
      })
    ).toEqual({
      allowedFields: ['verboseLogging'],
      rejectedFields: ['identityMd', 'model'],
      reason: 'field_owned_by_managed_release',
    });
  });
});
