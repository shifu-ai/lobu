import { describe, expect, it } from 'bun:test';
import { extractTrailingJsonObject } from '../../worker-api/run-lifecycle';

// The device-CLI completion contract: stdout must contain a JSON result
// object. Extraction is deliberately lenient about surrounding prose (the
// schema validation in handleCompleteWindow is the safety gate, not
// position) — these tests pin that behavior so a future "tidy-up" doesn't
// silently start failing runs over harmless epilogues.
describe('extractTrailingJsonObject', () => {
  it('parses output that is exactly one JSON object', () => {
    expect(extractTrailingJsonObject('{"summary": "ok"}')).toEqual({ summary: 'ok' });
  });

  it('parses the object after leading narration', () => {
    expect(
      extractTrailingJsonObject('Checked 5 stories, nothing relevant.\n\n{"summary": "0 drafts"}')
    ).toEqual({ summary: '0 drafts' });
  });

  it('accepts trailing prose after the object (lenient by design)', () => {
    expect(
      extractTrailingJsonObject('{"summary": "ok"}\n[output truncated]')
    ).toEqual({ summary: 'ok' });
  });

  it('parses the last ```json fenced block', () => {
    expect(
      extractTrailingJsonObject('Here is the result:\n```json\n{"summary": "fenced"}\n```\nDone.')
    ).toEqual({ summary: 'fenced' });
  });

  it('picks the LAST balanced object when several appear', () => {
    expect(
      extractTrailingJsonObject('{"summary": "draft"}\nrevised:\n{"summary": "final"}')
    ).toEqual({ summary: 'final' });
  });

  it('handles braces inside string values', () => {
    expect(
      extractTrailingJsonObject('note\n{"summary": "uses {braces} and \\"quotes\\" inside"}')
    ).toEqual({ summary: 'uses {braces} and "quotes" inside' });
  });

  it('returns null for prose with no JSON', () => {
    expect(extractTrailingJsonObject('Everything looks fine, nothing to report.')).toBeNull();
  });

  it('returns null for a top-level array (contract is an object)', () => {
    expect(extractTrailingJsonObject('[{"summary": "ok"}]')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(extractTrailingJsonObject('   \n  ')).toBeNull();
  });
});
