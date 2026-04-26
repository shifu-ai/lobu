import { describe, expect, test } from 'bun:test';
import { StreamRedactor, redactOutput } from '../executor/redact.js';

describe('redactOutput', () => {
  test('redacts HTTP Authorization header', () => {
    const input = 'GET /api\nAuthorization: Bearer abc123def456\nContent-Type: application/json';
    const out = redactOutput(input);
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts standalone Bearer tokens', () => {
    const input = 'curl -H "x: Bearer eyJhbGc.payload-here.sig9_=="';
    const out = redactOutput(input);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('payload-here.sig9_');
  });

  test('redacts JWTs anywhere they appear', () => {
    const input =
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c more';
    const out = redactOutput(input);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts CH_API_KEY env-style assignments', () => {
    const input = 'env: CH_API_KEY=abcdef-12345 done';
    const out = redactOutput(input);
    expect(out).not.toContain('abcdef-12345');
    expect(out).toContain('CH_API_KEY=[REDACTED]');
  });

  test('redacts api_key / access_token / secret JSON-style assignments', () => {
    const variants = [
      '"api_key": "longsecretvalue1234"',
      '"apiKey":"longsecretvalue1234"',
      "access_token = 'longsecretvalue1234'",
      'access-token: longsecretvalue1234',
      'secret="longsecretvalue1234"',
    ];
    for (const v of variants) {
      const out = redactOutput(v);
      expect(out).not.toContain('longsecretvalue1234');
      expect(out).toContain('[REDACTED]');
    }
  });

  test('preserves non-secret content', () => {
    const input = 'Connector started, fetched 12 events, no errors.';
    expect(redactOutput(input)).toBe(input);
  });

  test('handles empty input', () => {
    expect(redactOutput('')).toBe('');
  });

  test('does not redact short api_key-like values (avoid false positives on word "key")', () => {
    // The api_key pattern requires a 12+ char value to avoid eating things like
    // "no apikey set" or "key: id".
    const input = 'api_key: short';
    expect(redactOutput(input)).toBe(input);
  });
});

describe('StreamRedactor', () => {
  function collect(): { emit: (s: string) => void; out: () => string } {
    let buf = '';
    return { emit: (s) => (buf += s), out: () => buf };
  }

  test('redacts secret split across two chunks', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('GET /api\nAuthorization: Bear', c.emit);
    r.process('er abc123secret456\nfoo\n', c.emit);
    r.flush(c.emit);
    expect(c.out()).not.toContain('abc123secret456');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });

  test('emits complete lines as soon as a newline arrives', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('hello world\n', c.emit);
    expect(c.out()).toBe('hello world\n');
  });

  test('flush releases trailing partial line through redactor', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('line1\nAuthorization: Bearer secret_long_token', c.emit);
    expect(c.out()).toBe('line1\n');
    r.flush(c.emit);
    expect(c.out()).not.toContain('secret_long_token');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });

  test('emits prefix when buffer would exceed cap with no newline', () => {
    const r = new StreamRedactor();
    const c = collect();
    // 8200 chars, no newline — exceeds 8192 cap.
    r.process('x'.repeat(8200), c.emit);
    expect(c.out().length).toBeGreaterThan(0);
  });

  test('redacts a secret embedded near the cap-boundary even with no newline', () => {
    const r = new StreamRedactor();
    const c = collect();
    // A long no-newline payload with a secret somewhere inside. Cap is
    // 8192; the redactor must redact the entire combined buffer before
    // emitting, otherwise a slice near the cap could split the match.
    const payload = 'x'.repeat(8000) + 'Authorization: Bearer abc123secret456 ' + 'y'.repeat(500);
    r.process(payload, c.emit);
    expect(c.out()).not.toContain('abc123secret456');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });
});
