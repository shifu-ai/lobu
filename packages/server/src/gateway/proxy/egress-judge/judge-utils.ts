/**
 * Shared scaffolding for the egress judge and text judge.
 *
 * Both judges use the same default model, timeout constant, env-override
 * helper, and withTimeout wrapper. Centralising here removes ~40 lines of
 * duplication and keeps the two classes in sync when these values change.
 */

import { EGRESS_JUDGE_MODEL } from "@lobu/core";

/**
 * Default Haiku model for all judge calls. Fast + cheap; invoked only when
 * a rule with `action: "judge"` matches. Sourced from the centralized model
 * ID constants in @lobu/core.
 */
export const DEFAULT_JUDGE_MODEL = EGRESS_JUDGE_MODEL;

/**
 * Hard ceiling on a single judge call. On expiry the call is abandoned, the
 * verdict fails closed (deny), and the timeout counts as a circuit-breaker
 * failure. Overridable via `EGRESS_JUDGE_TIMEOUT_MS`.
 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 8_000;

/**
 * Read the optional `EGRESS_JUDGE_TIMEOUT_MS` env var.
 * Returns undefined when the var is absent or invalid.
 */
export function envTimeoutMs(): number | undefined {
  const raw = process.env.EGRESS_JUDGE_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Thrown when `withTimeout` races a judge promise past its deadline.
 * Caught by both judges to record a circuit-breaker failure and return
 * a fail-closed deny verdict.
 */
export class JudgeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Judge call exceeded ${timeoutMs}ms`);
    this.name = "JudgeTimeoutError";
  }
}

/**
 * Race `promise` against a hard deadline. The underlying promise is left to
 * settle on its own (we can't cancel it), but the caller sees a
 * {@link JudgeTimeoutError} once the deadline passes.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new JudgeTimeoutError(timeoutMs)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
