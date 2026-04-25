/**
 * Isolated-vm script runner.
 *
 * Compiles a TypeScript user-script via esbuild, runs it inside a V8 isolate
 * with a bridge back to the host `ClientSDK`, and returns a structured result.
 *
 * Design invariants
 * - Every call creates a fresh Isolate and disposes it. No pooling in v1.
 * - Memory cap enforced by V8; CPU interrupts via `script.run({ timeout })`.
 * - SDK calls cross the isolate boundary as JSON (Reference + ExternalCopy).
 * - Console logs and the return value are captured and returned structurally.
 * - `client.org()` is stateless: each guest call carries `orgPath` so the
 *   host can re-walk org swaps deterministically without holding refs.
 */

import type { ClientSDK } from "./client-sdk";

/** Hard limits enforced by the runner. Callers can lower but not raise. */
export interface RunLimits {
  /** V8 isolate heap cap, MB. Default 64. */
  memoryMb?: number;
  /** Wall-clock budget for the script body, ms. Default 60_000. */
  timeoutMs?: number;
  /** SDK call quota. Scripts exceeding throw QuotaExceeded. Default 200. */
  sdkCallQuota?: number;
  /** Captured output size cap (logs + return value), bytes. Default 262_144. */
  outputBytes?: number;
}

export interface RunScriptOptions {
  /** TypeScript source of the user script. esbuild compiles to CJS + esnext target. */
  source: string;
  /** Injected into the guest as `ctx`. JSON-serializable. */
  context?: Record<string, unknown>;
  /** Host SDK the guest calls via the bridge. */
  sdk: ClientSDK;
  limits?: RunLimits;
  /**
   * Extra positional arguments passed to the entry point after `(ctx, client)`.
   * Reactions use this to forward `params` from the stored watcher version.
   */
  extraArgs?: unknown[];
}

export interface LogEntry {
  level: "log" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  ts: number;
}

export interface RunScriptResult {
  success: boolean;
  returnValue?: unknown;
  logs: LogEntry[];
  error?: {
    name: string;
    message: string;
    stack?: string;
    line?: number;
    column?: number;
  };
  durationMs: number;
  sdkCalls: number;
}

const DEFAULT_LIMITS: Required<RunLimits> = {
  memoryMb: 64,
  timeoutMs: 60_000,
  sdkCallQuota: 200,
  outputBytes: 262_144,
};

/**
 * Load `isolated-vm` lazily. Returns null when the optional native module is
 * not installed (e.g. local dev on a Node version without a prebuild).
 */
async function loadIsolatedVm(): Promise<typeof import("isolated-vm") | null> {
  try {
    return await import("isolated-vm");
  } catch {
    return null;
  }
}

const GUEST_PREAMBLE = `
const ctx = JSON.parse(__ctx_json);

// Symbol/awaitable/coercion keys that JS may probe automatically (e.g. when a
// guest accidentally awaits a namespace proxy or runs JSON.stringify(client.x)).
// Returning undefined here avoids turning every accidental probe into a host
// SDK call that consumes quota or throws \`Unknown SDK method\`.
function __isReservedKey(k) {
  return typeof k === 'symbol'
    || k === 'then'
    || k === 'catch'
    || k === 'finally'
    || k === 'inspect'
    || k === 'constructor'
    || k === '__proto__'
    || k === 'toJSON'
    || k === 'toString'
    || k === 'valueOf';
}

function __makeClient(orgPath) {
  return new Proxy({}, {
    get(_, key) {
      if (__isReservedKey(key)) return undefined;
      const k = String(key);
      if (k === 'org') {
        return async (slug) => __makeClient([...orgPath, String(slug)]);
      }
      if (k === 'query' || k === 'log') {
        return async (...args) => {
          const payload = JSON.stringify({ args, orgPath });
          const r = await __sdk_dispatch.apply(undefined, [k, payload], { result: { promise: true, copy: true } });
          return r === undefined ? undefined : JSON.parse(r);
        };
      }
      // Namespace proxy
      return new Proxy({}, {
        get(_, methodKey) {
          if (__isReservedKey(methodKey)) return undefined;
          const m = String(methodKey);
          return async (...args) => {
            const payload = JSON.stringify({ args, orgPath });
            const r = await __sdk_dispatch.apply(undefined, [k + '.' + m, payload], { result: { promise: true, copy: true } });
            return r === undefined ? undefined : JSON.parse(r);
          };
        }
      });
    }
  });
}

const client = __makeClient([]);

const console = {
  log: (...a) => { try { __console_call.applySync(undefined, ['log', a.map(String).join(' ')]); } catch (e) {} },
  warn: (...a) => { try { __console_call.applySync(undefined, ['warn', a.map(String).join(' ')]); } catch (e) {} },
  error: (...a) => { try { __console_call.applySync(undefined, ['error', a.map(String).join(' ')]); } catch (e) {} },
};

const module = { exports: {} };
const exports = module.exports;
`;

// Picks `default`, falling back to the bare module export when the script
// was written as a single function expression. Stored reaction scripts must
// use the new `export default async (ctx, client, params?) => ...` shape;
// migrate the database when shipping this change.
const GUEST_RUNNER = `
(async () => {
  const __entry = module.exports.default
    ?? (typeof module.exports === 'function' ? module.exports : null);
  if (typeof __entry !== 'function') {
    throw new Error('Script must \`export default\` an async function');
  }
  const __extra = JSON.parse(__extra_args_json);
  const __result = await __entry(ctx, client, ...__extra);
  return __result === undefined ? null : JSON.stringify(__result);
})()
`;

export async function runScript(
  options: RunScriptOptions,
): Promise<RunScriptResult> {
  const started = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };

  const logs: LogEntry[] = [];
  let sdkCalls = 0;
  let outputBytes = 0;

  const ivm = await loadIsolatedVm();
  if (!ivm) {
    return {
      success: false,
      logs: [],
      error: {
        name: "RuntimeUnavailable",
        message:
          "isolated-vm is not installed for this platform. Install with `bun install` on a supported Node version (18–24 with prebuilt binaries, or any version with python3 + build-essential available).",
      },
      durationMs: Date.now() - started,
      sdkCalls: 0,
    };
  }

  // Compile TS via the existing esbuild path. CompileError surfaces with line/col.
  let compiled: string;
  try {
    const { compileSource } = await import("../utils/compiler-core");
    const result = await compileSource(options.source, {
      tmpPrefix: ".execute-compile-",
      label: "ExecuteCompiler",
      buildOptions: {
        format: "cjs",
        target: "esnext",
        platform: "node",
        external: [],
      },
    });
    compiled = result.compiledCode;
  } catch (err) {
    const e = err as Error & { errors?: Array<{ location?: { line?: number; column?: number } }> };
    const loc = e.errors?.[0]?.location;
    return {
      success: false,
      logs,
      error: {
        name: "CompileError",
        message: e.message,
        line: loc?.line,
        column: loc?.column,
      },
      durationMs: Date.now() - started,
      sdkCalls: 0,
    };
  }

  const isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    // Async dispatch back to the host SDK.
    await jail.set(
      "__sdk_dispatch",
      new ivm.Reference(async (path: string, payloadJson: string) => {
        sdkCalls++;
        if (sdkCalls > limits.sdkCallQuota) {
          throw new Error(
            `QuotaExceeded: SDK call quota of ${limits.sdkCallQuota} reached`,
          );
        }
        const { args, orgPath } = JSON.parse(payloadJson) as {
          args: unknown[];
          orgPath: string[];
        };

        // Walk org chain: each .org() returns a new SDK; chain re-validates.
        let target: ClientSDK = options.sdk;
        for (const slug of orgPath) {
          target = await target.org(slug);
        }

        let result: unknown;
        if (path === "log") {
          target.log(args[0] as string, args[1] as Record<string, unknown> | undefined);
          result = undefined;
        } else if (path === "query") {
          result = await target.query(args[0] as string);
        } else {
          const [ns, method] = path.split(".");
          if (!ns || !method) {
            throw new Error(`Invalid SDK path: '${path}'`);
          }
          // Restrict to actual SDK namespaces (own enumerable keys of the
          // resolved target). Anything else (constructor, __proto__, etc.)
          // is rejected before the function call. Belt-and-braces with the
          // guest-side reserved-key filter.
          if (!Object.prototype.hasOwnProperty.call(target, ns)) {
            throw new Error(`Unknown SDK namespace: '${ns}'`);
          }
          const namespace = (target as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[ns];
          if (
            !namespace ||
            typeof namespace !== "object" ||
            !Object.prototype.hasOwnProperty.call(namespace, method) ||
            typeof namespace[method] !== "function"
          ) {
            throw new Error(`Unknown SDK method: '${path}'`);
          }
          result = await namespace[method](...args);
        }

        if (result === undefined) return undefined;
        const json = JSON.stringify(result);
        outputBytes += json.length;
        if (outputBytes > limits.outputBytes) {
          throw new Error(
            `OutputSizeExceeded: combined output exceeded ${limits.outputBytes} bytes`,
          );
        }
        return json;
      }),
    );

    // Console capture (synchronous; logs counted toward output budget).
    await jail.set(
      "__console_call",
      new ivm.Reference((level: "log" | "warn" | "error", message: string) => {
        outputBytes += message.length;
        if (outputBytes > limits.outputBytes) return; // silently drop overflow
        logs.push({ level, message, ts: Date.now() });
      }),
    );

    await jail.set("__ctx_json", JSON.stringify(options.context ?? {}));
    await jail.set(
      "__extra_args_json",
      JSON.stringify(options.extraArgs ?? []),
    );

    // Compile preamble + user code + runner into one script. The runner
    // returns a JSON string of the user's return value (or null).
    const fullSource = `${GUEST_PREAMBLE}\n${compiled}\n${GUEST_RUNNER}`;
    const script = await isolate.compileScript(fullSource);

    const resultPromise = script.run(context, {
      timeout: limits.timeoutMs,
      promise: true,
      copy: true,
    });
    const returnJson = (await resultPromise) as string | null;
    if (returnJson) {
      outputBytes += returnJson.length;
      if (outputBytes > limits.outputBytes) {
        throw new Error(
          `OutputSizeExceeded: combined output exceeded ${limits.outputBytes} bytes`,
        );
      }
    }
    const returnValue = returnJson ? JSON.parse(returnJson) : null;

    return {
      success: true,
      returnValue,
      logs,
      durationMs: Date.now() - started,
      sdkCalls,
    };
  } catch (err) {
    const e = err as Error;
    const isTimeout = /script execution timed out/i.test(e.message);
    const isQuota = /QuotaExceeded/.test(e.message);
    const isOom = /memory|allocation|isolate was disposed/i.test(e.message);
    const name = isTimeout
      ? "TimeoutError"
      : isQuota
        ? "QuotaExceeded"
        : isOom
          ? "OutOfMemory"
          : "ScriptError";
    return {
      success: false,
      logs,
      error: { name, message: e.message, stack: e.stack },
      durationMs: Date.now() - started,
      sdkCalls,
    };
  } finally {
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
  }
}

/** Exposed for tests that need to assert default limits without invoking the runner. */
export function getDefaultLimits(): Required<RunLimits> {
  return { ...DEFAULT_LIMITS };
}
