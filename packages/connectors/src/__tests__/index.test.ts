import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The connectors index is a flat re-export barrel — `export * from './<name>.ts'`
// for every connector module. Testing the runtime shape would require loading
// every connector (and pulling playwright/baileys/turndown bootstrapping on
// import), which is what the connector integration suites are for.
//
// What we *can* validate cheaply, and what catches a real human mistake (a new
// connector landed in the dir but the author forgot to wire it through the
// barrel), is that every sibling `*.ts` source file is referenced from index.ts.

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
  // Match `export * from './<name>.ts';`
  const matches = [...text.matchAll(/export \* from ['"]\.\/([^'"]+?)\.ts['"];?/g)];
  return matches.map((m) => m[1]).sort();
}

describe('connectors index barrel', () => {
  test('re-exports every sibling connector module', () => {
    const sources = loadConnectorSourceNames();
    const exported = loadIndexExportNames();
    expect(exported).toEqual(sources);
  });

  test('does not re-export anything that has no source file', () => {
    const sources = new Set(loadConnectorSourceNames());
    const exported = loadIndexExportNames();
    for (const name of exported) {
      expect(sources.has(name)).toBe(true);
    }
  });

  test('every re-export uses the explicit `.ts` extension form', () => {
    const text = readFileSync(INDEX_PATH, 'utf8');
    // Reject bare specifiers like `export * from './capterra';` (no extension)
    // because the package's published `exports` map relies on the `.ts` form
    // resolving via the `./*` subpath pattern in package.json.
    const bareReexport = /export \* from ['"]\.\/[^'"]+['"]/g;
    for (const match of text.matchAll(bareReexport)) {
      expect(match[0]).toMatch(/\.ts['"]/);
    }
  });

  test('includes the shared browser-scraper utilities re-export', () => {
    expect(loadIndexExportNames()).toContain('browser-scraper-utils');
  });

  test('lists at least the well-known core connectors', () => {
    const exported = new Set(loadIndexExportNames());
    for (const expected of [
      'github',
      'hackernews',
      'reddit',
      'rss',
      'website',
      'youtube',
    ]) {
      expect(exported.has(expected)).toBe(true);
    }
  });
});
