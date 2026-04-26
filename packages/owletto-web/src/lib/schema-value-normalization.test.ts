import { describe, expect, it } from 'vitest';
import { normalizeEnumValue, normalizeMetadataForSchema } from './schema-value-normalization';

describe('normalizeEnumValue', () => {
  it('unwraps accidentally JSON-stringified enum values', () => {
    expect(normalizeEnumValue('"active"', ['active', 'invited'])).toBe('active');
  });

  it('leaves already-valid enum values unchanged', () => {
    expect(normalizeEnumValue('invited', ['active', 'invited'])).toBe('invited');
  });

  it('does not coerce values outside the enum', () => {
    expect(normalizeEnumValue('"archived"', ['active', 'invited'])).toBe('"archived"');
  });
});

describe('normalizeMetadataForSchema', () => {
  it('normalizes enum-backed fields and leaves other fields alone', () => {
    expect(
      normalizeMetadataForSchema(
        {
          status: '"active"',
          email: 'alice@example.com',
          note: '"keep quoted text"',
        },
        {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'invited'] },
            email: { type: 'string' },
            note: { type: 'string' },
          },
        }
      )
    ).toEqual({
      status: 'active',
      email: 'alice@example.com',
      note: '"keep quoted text"',
    });
  });
});
