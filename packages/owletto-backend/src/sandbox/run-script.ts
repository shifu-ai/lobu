/**
 * Isolated-vm script runner.
 *
 * Compiles a TypeScript user-script via esbuild, runs it inside a V8 isolate
 * with a bridge back to the host `ClientSDK`, and returns a structured result.
 *
 * Scope of PR-1: shape + skeleton. PR-2 wires this into `execute` and
 * reactions. The native `isolated-vm` module is an **optional** dependency so
 * the package installs cleanly on platforms without a matching prebuild; the
 * module is loaded lazily at first call.
 *
 * Design invariants
 * - Every call creates a fresh Isolate and disposes it. No pooling in v1.
 * - Memory cap enforced by V8; CPU interrupts via `script.run({ timeout })`.
 * - SDK calls cross the isolate boundary as JSON (ExternalCopy + Reference).
 * - Console logs and the return value are captured and returned structurally.
 */

import type { ClientSDK } from "./client-sdk";

/** Hard limits enforced by the runner. Callers can lower but not raise. */
export interface RunLimits {
  /** V8 isolate heap cap, MB. Default 64. */
  memoryMb?: number;
  /** Wall-clock budget, ms. Default 60_000. */
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
  /** Entry-point function name exposed by user source. Default 'default'. */
  entryPoint?: "default" | "react";
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
 * not installed (e.g. local dev on a Node version without a prebuild). Callers
 * surface a clear error so users know how to remediate.
 */
async function loadIsolatedVm(): Promise<typeof import("isolated-vm") | null> {
  try {
    const mod = await import("isolated-vm");
    return mod;
  } catch {
    return null;
  }
}

/**
 * Run a user script inside a V8 isolate. Skeleton implementation for PR-1 —
 * the host-side SDK bridge and esbuild pipeline land in PR-2. Today returns a
 * clear error if invoked so tests can verify the code path without requiring
 * the native module.
 */
export async function runScript(
  options: RunScriptOptions
): Promise<RunScriptResult> {
  const started = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };

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

  // PR-1 ships the module wiring; the full esbuild + bridge implementation
  // lands in PR-2. For now, this short-circuits with a descriptive error so
  // tests can assert the loader path and limits shape without depending on
  // the bridge.
  void limits;
  void options.sdk;
  void options.source;
  void options.context;
  void options.entryPoint;

  return {
    success: false,
    logs: [],
    error: {
      name: "NotImplemented",
      message:
        "runScript implementation lands in PR-2 (execute + search tool wiring).",
    },
    durationMs: Date.now() - started,
    sdkCalls: 0,
  };
}

/** Exposed for tests that need to assert default limits without invoking the runner. */
export function getDefaultLimits(): Required<RunLimits> {
  return { ...DEFAULT_LIMITS };
}
