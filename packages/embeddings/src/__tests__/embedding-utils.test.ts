import { describe, expect, test } from 'bun:test';
import { normalizeEmbeddings, validateEmbeddingDimensions } from '../embedding-utils';

function l2Norm(vec: number[]): number {
  return Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
}

describe('normalizeEmbeddings', () => {
  test('returns an empty array for an empty input', () => {
    expect(normalizeEmbeddings([])).toEqual([]);
  });

  test('produces unit-length vectors for non-zero inputs', () => {
    const input = [
      [3, 4],
      [1, 2, 2],
    ];
    const result = normalizeEmbeddings(input);

    expect(result).toHaveLength(2);
    expect(l2Norm(result[0])).toBeCloseTo(1, 10);
    expect(l2Norm(result[1])).toBeCloseTo(1, 10);

    // 3-4-5 triangle: [3,4] / 5 = [0.6, 0.8]
    expect(result[0][0]).toBeCloseTo(0.6, 10);
    expect(result[0][1]).toBeCloseTo(0.8, 10);
  });

  test('preserves direction (cosine similarity to original is 1)', () => {
    const v = [2, 0, -2, 1];
    const [normalized] = normalizeEmbeddings([v]);
    const dot = v.reduce((sum, x, i) => sum + x * normalized[i], 0);
    const expected = l2Norm(v);
    expect(dot).toBeCloseTo(expected, 10);
  });

  test('returns the zero vector unchanged when norm is zero', () => {
    const result = normalizeEmbeddings([[0, 0, 0]]);
    expect(result).toEqual([[0, 0, 0]]);
  });

  test('does not mutate the input arrays', () => {
    const input = [[3, 4]];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeEmbeddings(input);
    expect(input).toEqual(snapshot);
  });

  test('normalizes already-unit vectors to themselves', () => {
    const input = [[1, 0, 0]];
    const [out] = normalizeEmbeddings(input);
    expect(out[0]).toBeCloseTo(1, 10);
    expect(out[1]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(0, 10);
  });
});

describe('validateEmbeddingDimensions', () => {
  test('passes when dimensions match', () => {
    expect(() =>
      validateEmbeddingDimensions([0.1, 0.2, 0.3], 3, 'ctx')
    ).not.toThrow();
  });

  test('throws an Error mentioning the actual and expected dimensions and the context', () => {
    expect(() => validateEmbeddingDimensions([1, 2], 5, 'my-ctx')).toThrow(
      'my-ctx: unexpected embedding dimensions 2 (expected 5)'
    );
  });

  test('handles the empty embedding case', () => {
    expect(() => validateEmbeddingDimensions([], 1, 'ctx')).toThrow(
      'ctx: unexpected embedding dimensions 0 (expected 1)'
    );
  });

  test('passes when expecting zero-length and getting zero-length', () => {
    expect(() => validateEmbeddingDimensions([], 0, 'ctx')).not.toThrow();
  });
});
