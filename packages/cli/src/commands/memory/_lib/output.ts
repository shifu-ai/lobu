// Memory commands output JSON whenever the parent process passes --json.
// commander parses the flag at the program level; for now memory commands are
// human-formatted by default. If we ever wire JSON-mode globally, flip this.
const jsonMode = false;

export function isJson() {
  return jsonMode;
}

export function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printText(text: string) {
  process.stdout.write(`${text}\n`);
}

export function printError(message: string) {
  process.stderr.write(`error: ${message}\n`);
}
