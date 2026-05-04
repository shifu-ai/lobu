import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// Mock @xenova/transformers BEFORE importing the module under test, because
// importing embeddings.ts touches `transformersEnv.cacheDir` and
// `transformersEnv.backends.onnx.wasm.numThreads` at module load.
//
// Note: mock.module is process-global in `bun test`, so multiple test files
// in the same run share the registered mock. These tests therefore assert
// only on properties that are stable regardless of which fake extractor is
// active — call shape, return-array length per input, the empty-input
// short-circuit, and getLocalModelInfo() behavior (which never invokes the
// extractor).
function makeFakeVector(): Float32Array {
  return new Float32Array(768).fill(0.5);
}

mock.module('@xenova/transformers', () => ({
  pipeline: mock(async () => mock(async () => ({ data: makeFakeVector() }))),
  env: {
    cacheDir: '',
    backends: { onnx: { wasm: { numThreads: 1 } } },
  },
}));

// Now import the module under test.
import {
  batchGenerateLocalEmbeddings,
  generateLocalEmbedding,
  getLocalModelInfo,
} from '../embeddings';

const ORIGINAL_MODEL = process.env.EMBEDDINGS_MODEL;

describe('getLocalModelInfo', () => {
  beforeAll(() => {
    delete process.env.EMBEDDINGS_MODEL;
  });

  afterAll(() => {
    if (ORIGINAL_MODEL === undefined) {
      delete process.env.EMBEDDINGS_MODEL;
    } else {
      process.env.EMBEDDINGS_MODEL = ORIGINAL_MODEL;
    }
  });

  test('returns the default model name and 768 dimensions when EMBEDDINGS_MODEL is unset', () => {
    delete process.env.EMBEDDINGS_MODEL;
    const info = getLocalModelInfo();
    expect(info.dimensions).toBe(768);
    expect(info.model).toBe('Xenova/bge-base-en-v1.5');
  });

  test('returns EMBEDDINGS_MODEL when set', () => {
    process.env.EMBEDDINGS_MODEL = 'Xenova/all-MiniLM-L6-v2';
    expect(getLocalModelInfo()).toEqual({
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 768,
    });
  });

  test('always reports 768 dimensions regardless of env', () => {
    process.env.EMBEDDINGS_MODEL = 'whatever-model';
    expect(getLocalModelInfo().dimensions).toBe(768);
  });
});

describe('generateLocalEmbedding', () => {
  test('returns a non-empty number[] derived from the extractor output', async () => {
    const result = await generateLocalEmbedding('hello');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const value of result) {
      expect(typeof value).toBe('number');
    }
  });

  test('returns equal-length vectors for two different inputs', async () => {
    const a = await generateLocalEmbedding('first input');
    const b = await generateLocalEmbedding('second input');
    expect(a.length).toBe(b.length);
  });
});

describe('batchGenerateLocalEmbeddings', () => {
  test('returns an empty array immediately for empty input', async () => {
    const result = await batchGenerateLocalEmbeddings([]);
    expect(result).toEqual([]);
  });

  test('returns one embedding per input text', async () => {
    const inputs = ['alpha', 'beta', 'gamma'];
    const result = await batchGenerateLocalEmbeddings(inputs);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(Array.isArray(v)).toBe(true);
      expect(v.length).toBeGreaterThan(0);
    }
  });

  test('returns one embedding per input across multiple internal batches', async () => {
    const inputs = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const result = await batchGenerateLocalEmbeddings(inputs, 2);
    expect(result).toHaveLength(inputs.length);
    // All embeddings must have the same length.
    const len = result[0].length;
    for (const v of result) {
      expect(v.length).toBe(len);
    }
  });

  test('respects a batchSize larger than the input list', async () => {
    const inputs = ['only-one'];
    const result = await batchGenerateLocalEmbeddings(inputs, 100);
    expect(result).toHaveLength(1);
  });

  test('handles batchSize equal to input length (single batch)', async () => {
    const inputs = ['x', 'y', 'z'];
    const result = await batchGenerateLocalEmbeddings(inputs, 3);
    expect(result).toHaveLength(3);
  });
});
