/**
 * Unit coverage for watchers.kind ('knowledge' | 'digest') plumbing (PM daily
 * digest, Task 3). Pure-function coverage only — no DB required:
 *
 *  - parseWatcherRunPayload: round-trips `kind` out of the persisted
 *    `runs.approved_input` payload, defaulting to 'knowledge' for older rows
 *    that predate this column (backward compatibility).
 *  - ManageWatchersSchema: accepts 'knowledge' | 'digest' for `kind`, rejects
 *    anything else, and treats it as optional (omitted = caller wants the
 *    column default).
 *
 * DB-backed create/update round-trip (the actual column read/write) is
 * covered in __tests__/integration/watchers/watchers-crud.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { parseWatcherRunPayload } from '../../watchers/automation';
import { ManageWatchersSchema } from '../../tools/admin/manage_watchers';

const basePayload = {
  watcher_id: 42,
  agent_id: 'agent-1',
  window_start: '2026-01-01T00:00:00.000Z',
  window_end: '2026-01-02T00:00:00.000Z',
  dispatch_source: 'scheduled',
};

describe('parseWatcherRunPayload — kind', () => {
  it('defaults kind to "knowledge" for payloads written before this column existed', () => {
    const parsed = parseWatcherRunPayload(basePayload);
    expect(parsed?.kind).toBe('knowledge');
  });

  it('round-trips kind="digest" from a stored payload', () => {
    const parsed = parseWatcherRunPayload({ ...basePayload, kind: 'digest' });
    expect(parsed?.kind).toBe('digest');
  });

  it('falls back to "knowledge" for a garbage kind value rather than propagating it', () => {
    const parsed = parseWatcherRunPayload({ ...basePayload, kind: 'not-a-real-kind' });
    expect(parsed?.kind).toBe('knowledge');
  });
});

describe('ManageWatchersSchema — kind', () => {
  const baseArgs = {
    action: 'create',
    slug: 'x',
    prompt: 'x',
    extraction_schema: { type: 'object', properties: {} },
    agent_id: 'agent-1',
  };

  it('is optional — omitting it is valid', () => {
    expect(Value.Check(ManageWatchersSchema, baseArgs)).toBe(true);
  });

  it('accepts "knowledge" and "digest"', () => {
    expect(Value.Check(ManageWatchersSchema, { ...baseArgs, kind: 'knowledge' })).toBe(true);
    expect(Value.Check(ManageWatchersSchema, { ...baseArgs, kind: 'digest' })).toBe(true);
  });

  it('rejects any other value', () => {
    expect(Value.Check(ManageWatchersSchema, { ...baseArgs, kind: 'bogus' })).toBe(false);
  });
});
