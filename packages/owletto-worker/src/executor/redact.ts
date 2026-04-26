/**
 * Redact secrets from connector subprocess output before it leaves the worker.
 *
 * Patterns are deliberately broad — false positives are preferred to leaking a
 * real credential into the runs table. Add new patterns here when a connector
 * surfaces a new sensitive shape.
 */

const REDACTED = '[REDACTED]';

const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // HTTP Authorization header (e.g. "Authorization: Bearer abc...") — match
  // the rest of the line so multi-token schemes like "Bearer xxx" get caught.
  { regex: /Authorization:[^\r\n]+/gi, replacement: `Authorization: ${REDACTED}` },

  // Bearer tokens anywhere
  { regex: /Bearer\s+[\w\-.~+/=]+/gi, replacement: `Bearer ${REDACTED}` },

  // JWT shape (eyJ...header.payload.sig)
  { regex: /eyJ[\w\-]+\.[\w\-]+\.[\w\-]+/g, replacement: REDACTED },

  // CH_API_KEY=value (literal env-var key from the connector ecosystem)
  {
    regex: /(CH_API_KEY)(["'\s:=]+["']?)([\w\-]+)(["']?)/gi,
    replacement: `$1$2${REDACTED}$4`,
  },

  // JSON/YAML/env-var style "api_key": "..." / apikey=... / access_token: ...
  // / secret = "..."
  {
    regex:
      /((?:api[_-]?key|apikey|access[_-]?token|secret))(["'\s:=]+["']?)([\w\-]{12,})(["']?)/gi,
    replacement: `$1$2${REDACTED}$4`,
  },
];

export function redactOutput(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}
