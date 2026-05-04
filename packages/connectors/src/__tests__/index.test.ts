import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The connectors index is a flat re-export barrel. Importing every connector
 * at runtime would pull playwright/baileys/turndown — that's e2e territory.
 *
 * What we *can* check cheaply is that the barrel and the source dir are in
 * sync. Catches a real human mistake: a connector lands in src/ but never
 * gets wired through index.ts.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..');
const INDEX_PATH = join(SRC_DIR, 'index.ts');

function loadConnectorSourceNames(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => name !== 'index.ts')
    .filter((name) => !name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/, ''))
    .sort();
}

function loadIndexExportNames(): string[] {
  const text = readFileSync(INDEX_PATH, 'utf8');
  return [...text.matchAll(/export \* from ['"]\.\/([^'"]+?)\.ts['"];?/g)]
    .map((m) => m[1])
    .sort();
}

describe('connectors index barrel', () => {
  test('every sibling source file is re-exported, and nothing else', () => {
    const sources = loadConnectorSourceNames();
    const exported = loadIndexExportNames();
    expect(exported).toEqual(sources);
  });

  test('every re-export uses the explicit `.ts` extension form (required by package exports map)', () => {
    const text = readFileSync(INDEX_PATH, 'utf8');
    // A bare specifier without `.ts` would fail the published `./*` subpath.
    for (const match of text.matchAll(/export \* from ['"]\.\/[^'"]+['"]/g)) {
      expect(match[0]).toMatch(/\.ts['"]/);
    }
  });
});
