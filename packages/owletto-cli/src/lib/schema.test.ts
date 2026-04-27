import { describe, expect, test } from 'bun:test';
import { validateModel } from './schema.ts';

describe('validateModel — relationship rules', () => {
  test('accepts a relationship without rules (any pair allowed)', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'founded_by',
        name: 'Founded By',
      },
      'founded_by.yaml'
    );
    expect(errors).toEqual([]);
  });

  test('accepts a relationship with a single rule', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'headquartered_in',
        name: 'Headquartered In',
        rules: [{ source: 'company', target: 'city' }],
      },
      'headquartered_in.yaml'
    );
    expect(errors).toEqual([]);
  });

  test('accepts multiple rules (e.g. operates_in → country|region)', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'operates_in',
        name: 'Operates In',
        rules: [
          { source: 'company', target: 'country' },
          { source: 'company', target: 'region' },
        ],
      },
      'operates_in.yaml'
    );
    expect(errors).toEqual([]);
  });

  test('rejects rules that is not an array', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'bad_rules',
        name: 'Bad Rules',
        rules: { source: 'company', target: 'city' },
      },
      'bad_rules.yaml'
    );
    expect(errors.map((e) => e.field)).toContain('rules');
  });

  test('rejects rules with missing source / target', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'bad_rules',
        name: 'Bad Rules',
        rules: [{ source: 'company' }, { target: 'city' }, {}],
      },
      'bad_rules.yaml'
    );
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('rules[0].target');
    expect(fields).toContain('rules[1].source');
    expect(fields).toContain('rules[2].source');
    expect(fields).toContain('rules[2].target');
  });

  test('rejects non-string source / target', () => {
    const errors = validateModel(
      {
        version: 1,
        type: 'relationship',
        slug: 'bad_rules',
        name: 'Bad Rules',
        rules: [{ source: 42, target: true }],
      },
      'bad_rules.yaml'
    );
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('rules[0].source');
    expect(fields).toContain('rules[0].target');
  });
});
