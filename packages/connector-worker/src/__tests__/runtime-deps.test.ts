import { describe, expect, test } from 'bun:test';
import {
  EXTERNAL_RUNTIME_DEPS,
  assertExternalDepsResolvable,
} from '../runtime-deps.js';

describe('EXTERNAL_RUNTIME_DEPS', () => {
  test('declares the runtime-installed externalized deps', () => {
    expect([...EXTERNAL_RUNTIME_DEPS]).toEqual(['playwright', 'sharp', 'jimp']);
  });

  test('is a frozen tuple of strings', () => {
    for (const dep of EXTERNAL_RUNTIME_DEPS) {
      expect(typeof dep).toBe('string');
      expect(dep.length).toBeGreaterThan(0);
    }
  });
});

describe('assertExternalDepsResolvable', () => {
  test('does nothing when every dep resolves successfully', () => {
    const seen: string[] = [];
    expect(() =>
      assertExternalDepsResolvable((spec) => {
        seen.push(spec);
      })
    ).not.toThrow();
    expect(seen).toEqual([...EXTERNAL_RUNTIME_DEPS]);
  });

  test('throws an aggregated error listing every missing dep', () => {
    const missingNames: string[] = [];
    let caught: Error | null = null;
    try {
      assertExternalDepsResolvable((spec) => {
        missingNames.push(spec);
        throw new Error('not installed');
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    const msg = caught!.message;
    for (const dep of EXTERNAL_RUNTIME_DEPS) {
      expect(msg).toContain(dep);
    }
    expect(msg).toContain('packages/connector-worker/src/runtime-deps.ts');
  });

  test('only reports the deps that actually fail', () => {
    let caught: Error | null = null;
    try {
      assertExternalDepsResolvable((spec) => {
        if (spec === 'sharp') throw new Error('not installed');
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('sharp');
    expect(caught!.message).not.toContain('playwright');
    expect(caught!.message).not.toContain('jimp');
  });
});
