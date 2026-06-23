const FIRST_PAUSE_MS = 30_000;
const MAX_PAUSE_MS = 5 * 60_000;
const PAUSE_AFTER_FAILURES = 3;

export interface McpServerHealthSnapshot {
  failures: number;
  lastError: string;
  pausedUntil?: number;
}

export interface McpServerPause {
  pausedUntil: number;
  lastError: string;
}

interface ServerHealthState {
  failures: number;
  lastError: string;
  pausedUntil?: number;
  nextPauseMs: number;
}

export class McpServerHealth {
  private readonly states = new Map<string, ServerHealthState>();

  getPause(serverKey: string, now = Date.now()): McpServerPause | null {
    const state = this.states.get(serverKey);
    if (!state?.pausedUntil || state.pausedUntil <= now) return null;
    return {
      pausedUntil: state.pausedUntil,
      lastError: state.lastError,
    };
  }

  recordFailure(
    serverKey: string,
    error: unknown,
    now = Date.now(),
    status?: number
  ): McpServerHealthSnapshot {
    const state = this.states.get(serverKey) ?? {
      failures: 0,
      lastError: "",
      nextPauseMs: FIRST_PAUSE_MS,
    };

    if (status === 401 || status === 403) {
      return this.toSnapshot(state);
    }

    state.failures += 1;
    state.lastError = this.errorMessage(error);

    if (state.failures >= PAUSE_AFTER_FAILURES) {
      state.pausedUntil = now + state.nextPauseMs;
      state.nextPauseMs = Math.min(state.nextPauseMs * 2, MAX_PAUSE_MS);
    }

    this.states.set(serverKey, state);
    return this.toSnapshot(state);
  }

  recordSuccess(serverKey: string): void {
    this.states.delete(serverKey);
  }

  private toSnapshot(state: ServerHealthState): McpServerHealthSnapshot {
    return {
      failures: state.failures,
      lastError: state.lastError,
      ...(state.pausedUntil ? { pausedUntil: state.pausedUntil } : {}),
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
