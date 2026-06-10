/** Shared CLI output helpers — one place for stdout/stderr formatting. */

export function printText(text: string) {
  process.stdout.write(`${text}\n`);
}

export function printError(message: string) {
  process.stderr.write(`error: ${message}\n`);
}

/** Pretty JSON by default; `raw` switches to compact JSON for piping. */
export function printJson(value: unknown, raw = false): void {
  const text = raw ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  process.stdout.write(`${text}\n`);
}
