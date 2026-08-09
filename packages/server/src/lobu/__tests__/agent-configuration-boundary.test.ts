import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SERVER_SRC = join(import.meta.dir, '..', '..');
const PACKAGES_ROOT = join(import.meta.dir, '..', '..', '..', '..');

const CONFIGURATION_SQL_ALLOWLIST = new Set([
  'lobu/agent-configuration/postgres-repository.ts',
]);

const CONFIGURATION_MUTATOR_ALLOWLIST = new Map([
  ['gateway/auth/agent-configuration-mutation-port.ts', new Set(['.updateSettings('])],
  ['gateway/services/core-services.ts', new Set(['.saveSettings('])],
]);

const CONFIGURATION_COLUMNS = [
  'model',
  'model_selection',
  'provider_model_preferences',
  'network_config',
  'egress_config',
  'nix_config',
  'mcp_servers',
  'soul_md',
  'user_md',
  'identity_md',
  'skills_config',
  'tools_config',
  'plugins_config',
  'installed_providers',
  'verbose_logging',
  'pre_approved_tools',
  'guardrails',
] as const;

const CONFIGURATION_COLUMN_PATTERN = new RegExp(
  `\\b(?:${CONFIGURATION_COLUMNS.join('|')})\\b`,
  'i'
);

async function productionTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionTypeScriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

function balancedParenthesizedBlock(source: string, openIndex: number): string | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return null;
}

function findConfigurationSql(source: string): string[] {
  const violations: string[] = [];
  const updatePattern = /\bUPDATE\s+(?:(?:"public"|public)\s*\.\s*)?(?:"agents"|agents)\s+SET\b/giu;
  for (const match of source.matchAll(updatePattern)) {
    const statement = source.slice(match.index, source.indexOf('`', match.index));
    if (CONFIGURATION_COLUMN_PATTERN.test(statement)) violations.push('UPDATE agents SET');
  }

  const insertPattern = /\bINSERT\s+INTO\s+(?:(?:"public"|public)\s*\.\s*)?(?:"agents"|agents)\s*\(/giu;
  for (const match of source.matchAll(insertPattern)) {
    const openIndex = source.indexOf('(', match.index);
    const columns = balancedParenthesizedBlock(source, openIndex);
    if (columns && CONFIGURATION_COLUMN_PATTERN.test(columns)) {
      violations.push('INSERT INTO agents(configuration columns)');
    }
  }
  return violations;
}

function findForbiddenHotPathImports(source: string): string[] {
  const violations: string[] = [];
  const importSpecifierPattern =
    /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(importSpecifierPattern)) {
    const specifier = match[1] ?? '';
    if (
      /(?:^|\/)runtime-capability-snapshot(?:\.[cm]?[jt]s)?$/u.test(specifier) ||
      /toolbox-[^/]*client/iu.test(specifier)
    ) {
      violations.push(specifier);
    }
  }
  return violations;
}

function findRawSettingsMutators(source: string): string[] {
  return [...source.matchAll(/\.\s*(saveSettings|updateSettings|deleteSettings)\s*\(/gu)].map(
    (match) => `.${match[1]}(`
  );
}

describe('agent configuration production boundary', () => {
  test('scanner detects multiline, schema-qualified, and quoted direct writers', () => {
    const representativeViolation = `
      await tx\`UPDATE "public"."agents"
        SET identity_md = \${prompt}, tools_config = \${tools}
        WHERE id = \${agentId}\`;
      await tx\`INSERT INTO "public"."agents" (
        id,
        model_selection,
        name
      ) VALUES (...)\`;
    `;
    expect(findConfigurationSql(representativeViolation)).toEqual([
      'UPDATE agents SET',
      'INSERT INTO agents(configuration columns)',
    ]);
    expect(findRawSettingsMutators('store .\n updateSettings (id, patch)')).toEqual([
      '.updateSettings(',
    ]);
  });

  test('hot-path scanner detects static, dynamic, and require imports', () => {
    expect(findForbiddenHotPathImports(`
      import { resolve } from '../services/runtime-capability-snapshot.js';
      const client = await import('../services/toolbox-agent-client.js');
      require('../services/toolbox-state-client.js');
    `)).toEqual([
      '../services/runtime-capability-snapshot.js',
      '../services/toolbox-agent-client.js',
      '../services/toolbox-state-client.js',
    ]);
  });

  test('persistent configuration SQL exists only in the authority repository', async () => {
    const violations: string[] = [];
    for (const file of await productionTypeScriptFiles(SERVER_SRC)) {
      const path = relative(SERVER_SRC, file).split(sep).join('/');
      if (CONFIGURATION_SQL_ALLOWLIST.has(path)) continue;
      for (const kind of findConfigurationSql(await readFile(file, 'utf8'))) {
        violations.push(`${path}: ${kind}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('raw settings mutators exist only in explicit embedded in-memory adapters', async () => {
    const violations: string[] = [];
    const allowedCalls: string[] = [];
    for (const file of await productionTypeScriptFiles(SERVER_SRC)) {
      const path = relative(SERVER_SRC, file).split(sep).join('/');
      for (const call of findRawSettingsMutators(await readFile(file, 'utf8'))) {
        if (CONFIGURATION_MUTATOR_ALLOWLIST.get(path)?.has(call)) {
          allowedCalls.push(`${path}: ${call}`);
        } else {
          violations.push(`${path}: ${call}`);
        }
      }
    }
    expect(violations).toEqual([]);
    expect(allowedCalls.sort()).toEqual([
      'gateway/auth/agent-configuration-mutation-port.ts: .updateSettings(',
      'gateway/services/core-services.ts: .saveSettings(',
    ]);
  });

  test('agent configuration and worker/session startup do not fetch Toolbox desired state', async () => {
    const serverHotPathFiles = [
      join(SERVER_SRC, 'lobu/agent-configuration/authority.ts'),
      join(SERVER_SRC, 'lobu/agent-configuration/postgres-repository.ts'),
      join(SERVER_SRC, 'gateway/services/session-manager.ts'),
      join(SERVER_SRC, 'gateway/session.ts'),
    ];
    const orchestrationRoot = join(SERVER_SRC, 'gateway/orchestration');
    const nonStartupOrchestrationAdapters = new Set([
      join(orchestrationRoot, 'course-context-gate.ts'),
      join(orchestrationRoot, 'message-consumer.ts'),
    ]);
    const orchestrationStartupFiles = (await productionTypeScriptFiles(orchestrationRoot))
      .filter((file) => !nonStartupOrchestrationAdapters.has(file));
    const agentWorkerFiles = await productionTypeScriptFiles(
      join(PACKAGES_ROOT, 'agent-worker/src')
    );
    const violations: string[] = [];
    for (const file of [
      ...serverHotPathFiles,
      ...orchestrationStartupFiles,
      ...agentWorkerFiles,
    ]) {
      for (const specifier of findForbiddenHotPathImports(await readFile(file, 'utf8'))) {
        violations.push(`${relative(PACKAGES_ROOT, file).split(sep).join('/')}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
