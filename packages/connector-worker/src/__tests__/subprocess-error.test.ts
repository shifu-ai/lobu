import { describe, expect, test } from 'bun:test';
import { SubprocessError } from '../executor/subprocess.js';

describe('SubprocessError', () => {
  test('extends Error and carries diagnostics fields', () => {
    const err = new SubprocessError('boom', {
      exitCode: 137,
      exitSignal: 'SIGKILL',
      outputTail: '[stderr]\nkilled',
      exitReason: 'oom',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.name).toBe('SubprocessError');
    expect(err.message).toBe('boom');
    expect(err.exitCode).toBe(137);
    expect(err.exitSignal).toBe('SIGKILL');
    expect(err.outputTail).toBe('[stderr]\nkilled');
    expect(err.exitReason).toBe('oom');
  });

  test('preserves the cause when provided', () => {
    const cause = new Error('underlying');
    const err = new SubprocessError(
      'wrapped',
      { exitCode: null, exitSignal: null, outputTail: '', exitReason: 'crash' },
      { cause }
    );
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });

  test('accepts every documented exitReason value', () => {
    const reasons: Array<'ok' | 'error_message' | 'timeout' | 'oom' | 'crash'> = [
      'ok',
      'error_message',
      'timeout',
      'oom',
      'crash',
    ];
    for (const reason of reasons) {
      const err = new SubprocessError('m', {
        exitCode: 0,
        exitSignal: null,
        outputTail: '',
        exitReason: reason,
      });
      expect(err.exitReason).toBe(reason);
    }
  });

  test('handles null exit code/signal (e.g. on IPC error path)', () => {
    const err = new SubprocessError('ipc error', {
      exitCode: null,
      exitSignal: null,
      outputTail: '',
      exitReason: 'error_message',
    });
    expect(err.exitCode).toBeNull();
    expect(err.exitSignal).toBeNull();
  });
});
