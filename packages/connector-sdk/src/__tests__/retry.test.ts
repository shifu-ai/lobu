import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { withHttpRetry } from '../retry.js';

// Speed up tests: p-retry honors minTimeout but tests can still take a few hundred ms.
// We keep retry counts low by either succeeding fast or aborting.

describe('withHttpRetry', () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    process.env.LOG_LEVEL = 'silent';
  });

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  test('returns the value when fn resolves on the first try', async () => {
    const fn = mock(async () => 'ok');
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (404)', async () => {
    const fn = mock(async () => {
      throw new Error('Resource not found (404)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/not found|404/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (401 unauthorized)', async () => {
    const fn = mock(async () => {
      throw new Error('Unauthorized request (401)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/unauthorized|401/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (403 forbidden)', async () => {
    const fn = mock(async () => {
      throw new Error('Forbidden (403)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/forbidden|403/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts immediately on permanent error (400 bad request)', async () => {
    const fn = mock(async () => {
      throw new Error('Bad Request (400)');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/bad request|400/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('aborts on non-retryable, non-permanent error (treated as abort)', async () => {
    const fn = mock(async () => {
      throw new Error('Some random unrelated failure');
    });
    await expect(withHttpRetry(fn)).rejects.toThrow(/random unrelated/i);
    // Non-retryable, non-permanent errors are also wrapped in AbortError → 1 call.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on retryable network error then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('ECONNRESET socket hangup');
      return 'recovered';
    });
    const onRetry = mock((_e: Error, _attempt: number) => {});
    const result = await withHttpRetry(fn, {
      operation: 'test-op',
      onRetry,
      context: { foo: 'bar' },
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 30000);

  test('retries on rate limit error then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('429 too many requests');
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('retries on server error (503) then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('Service unavailable 503');
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('retries on database error then succeeds', async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 2) throw new Error('postgres: deadlock detected');
      return 'ok';
    });
    const result = await withHttpRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 30000);

  test('handles non-Error throwable values', async () => {
    const fn = mock(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string error';
    });
    await expect(withHttpRetry(fn)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
