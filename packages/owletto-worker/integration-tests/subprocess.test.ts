/**
 * Integration tests for the subprocess diagnostic substrate.
 *
 * These spawn real child processes via SubprocessExecutor and require the
 * package (and its workspace deps) to be built. Run with:
 *
 *   make build-packages
 *   bun test packages/owletto-worker/integration-tests
 *
 * They live outside `src/` so tsc doesn't compile them and so `bun test`
 * picked up by default test discovery doesn't pull them into unit-test
 * runs that haven't built the workspace.
 */
import { describe, expect, test } from 'bun:test';
import type { SyncContext } from '../dist/executor/interface.js';
import { SubprocessError, SubprocessExecutor } from '../dist/executor/subprocess.js';

const BASE_CONTEXT: SyncContext = {
  options: {} as any,
  checkpoint: null,
  env: {},
  apiType: 'api',
};

function compiled(body: string): string {
  return `
    class ConnectorRuntime {
      async sync(_ctx, _hooks) {
        ${body}
      }
      async execute() { return { contents: [], checkpoint: null }; }
    }
    module.exports = { ConnectorRuntime };
  `;
}

describe('SubprocessExecutor diagnostic capture', () => {
  test('captures stdout tail and classifies as crash on process.exit(1)', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          console.log('starting connector run');
          console.log('about to die hard');
          process.exit(1);
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitCode).toBe(1);
    expect(err!.exitSignal).toBeNull();
    expect(err!.exitReason).toBe('crash');
    expect(err!.outputTail).toContain('about to die hard');
  });

  test('thrown sync() error is caught by the runner try/catch and reported as error_message', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          throw new Error('connector blew up');
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('connector blew up');
  });

  test('uncaughtException handler catches asynchronous setTimeout throw', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          setTimeout(() => { throw new Error('async tick throw'); }, 0);
          await new Promise(() => {});
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('async tick throw');
  });

  test('unhandledRejection handler catches dangling Promise.reject', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          Promise.reject(new Error('dangling rejection'));
          await new Promise(() => {});
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('dangling rejection');
  });

  test('output tail is redacted before reaching the parent', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          console.error('Authorization: Bearer abc123secret456789');
          console.error('CH_API_KEY=longvaluesecret789');
          process.exit(1);
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.outputTail).not.toContain('abc123secret456789');
    expect(err!.outputTail).not.toContain('longvaluesecret789');
    expect(err!.outputTail).toContain('[REDACTED]');
  });

  test('classifies parent-driven SIGKILL as timeout', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 1_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          await new Promise(() => {});
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('timeout');
  });
});
