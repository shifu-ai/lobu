/**
 * Process-wide lifecycle flag shared between the shutdown sequence
 * (`server-lifecycle.ts`) and the readiness probe (`index.ts`).
 *
 * On SIGTERM the shutdown handler flips this to `true` BEFORE tearing anything
 * down, so `/health/ready` immediately starts returning 503. That deregisters
 * the pod from the k8s Service endpoint set, letting in-flight requests drain
 * while kube-proxy stops routing new ones to a pod that is about to close its
 * gateway and DB pool. Without it, readiness stays 200 until the listener
 * closes at the very end of shutdown and new requests keep landing on a
 * half-torn-down process (500s/resets on every rollout).
 */
import type http from "node:http";

let shuttingDown = false;

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Parse a non-negative duration (ms) env var, falling back on absent/invalid. */
export function parseDurationMs(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

/** Sleep without keeping the event loop alive solely for the timer. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * Stop accepting new connections and wait for in-flight requests to finish,
 * up to `deadlineMs`. After the deadline, force-close lingering sockets
 * (long-lived SSE / keep-alive) so teardown can proceed. Draining the HTTP
 * server BEFORE the gateway and DB pool means in-flight requests don't hit a
 * half-torn-down process during a rollout. Resolves once closed or forced.
 */
export async function drainHttpServer(
  server: http.Server,
  deadlineMs: number,
  onForceClose?: (deadlineMs: number) => void
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.close(() => finish());
    const timer = setTimeout(() => {
      onForceClose?.(deadlineMs);
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      finish();
    }, deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
}
