/**
 * Unit coverage for the digest-watcher dispatch branch (PM daily digest,
 * Task 4). Pure-function coverage only — no DB, no embedded Lobu gateway:
 *
 *  - buildDispatchMessage: digest payloads produce a toolbox-MCP prompt
 *    (get_pm_daily_context / send_daily_digest), never the lobu-memory
 *    read_knowledge / complete_window script; knowledge payloads (or a
 *    payload with no `kind` at all) keep the ORIGINAL script byte-for-byte.
 *  - watcherRunSucceedsWithoutWindow: the fail-closed decision extracted
 *    from registerWatcherRunHandle's onResolve — digest runs succeed without
 *    a watcher_windows row, knowledge runs still fail closed.
 *  - preflightDigestWatcherMcp: degrades to a local settings.mcpServers
 *    check (via resolveConnectorMcpId) instead of a live remote tools/list,
 *    since the toolbox MCP is a remote per-user OAuth MCP that a
 *    service-token preflight fetch cannot authenticate through.
 *
 * DB-backed dispatch/onResolve wiring is covered by the existing
 * __tests__/integration/watchers/automation-contract.test.ts suite.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildDispatchMessage,
  preflightDigestWatcherMcp,
  watcherRunSucceedsWithoutWindow,
} from '../../watchers/automation';
import type { WatcherRunPayload } from '../../utils/queue-helpers';

function basePayload(overrides: Partial<WatcherRunPayload> = {}): WatcherRunPayload {
  return {
    watcher_id: 42,
    agent_id: 'agent-1',
    window_start: '2026-07-04T00:00:00.000Z',
    window_end: '2026-07-05T00:00:00.000Z',
    dispatch_source: 'scheduled',
    kind: 'knowledge',
    version_id: null,
    device_worker_id: null,
    agent_kind: null,
    ...overrides,
  };
}

const baseParams = {
  watcherId: 42,
  runId: 100,
  agentId: 'agent-1',
  sessionAgentId: 'session-agent-1',
};

describe('buildDispatchMessage — kind branch', () => {
  it('digest payload calls get_pm_daily_context and send_daily_digest', () => {
    const message = buildDispatchMessage({
      ...baseParams,
      payload: basePayload({ kind: 'digest' }),
    });

    expect(message).toContain('get_pm_daily_context');
    expect(message).toContain('send_daily_digest');
  });

  it('digest payload never mentions the knowledge-extraction tools', () => {
    const message = buildDispatchMessage({
      ...baseParams,
      payload: basePayload({ kind: 'digest' }),
    });

    expect(message).not.toContain('read_knowledge');
    expect(message).not.toContain('complete_window');
  });

  it('digest payload instructs calling get_pm_daily_context with today= the computed date, so the toolbox-side client filter actually narrows to today (M1 fix)', () => {
    const message = buildDispatchMessage({
      ...baseParams,
      payload: basePayload({ kind: 'digest', window_start: '2026-07-04T00:00:00.000Z' }),
    });

    // window_start is UTC midnight of 2026-07-04, so `today` renders as
    // 2026-07-04 (YYYY-MM-DD) — the exact format get_pm_daily_context's
    // `today` arg expects for its client-side date-string comparison.
    expect(message).toMatch(/get_pm_daily_context.*today="2026-07-04"/);
  });

  it('digest payload instructs skip-not-fabricate for unavailable/unauthorized sources', () => {
    const message = buildDispatchMessage({
      ...baseParams,
      payload: basePayload({ kind: 'digest' }),
    });

    expect(message).toMatch(/不要編造|不要捏造/);
  });

  it('knowledge payload keeps the original read_knowledge/complete_window script unchanged', () => {
    const message = buildDispatchMessage({
      ...baseParams,
      payload: basePayload({ kind: 'knowledge' }),
    });

    expect(message).toBe(
      [
        'Run this watcher now using the lobu-memory MCP tools.',
        '',
        'Watcher ID: 42',
        'Watcher run ID: 100',
        'Assigned agent ID: agent-1',
        'Session agent ID: session-agent-1',
        'Queued window start: 2026-07-04T00:00:00.000Z',
        'Queued window end: 2026-07-05T00:00:00.000Z',
        'Dispatch source: scheduled',
        '',
        'Required steps:',
        '1. Call read_knowledge with {"watcher_id": 42, "since": "2026-07-04", "until": "2026-07-04"}.',
        '2. Analyze the returned content using prompt_rendered and extraction_schema.',
        '3. Call manage_watchers(action="complete_window") with the returned window_token, extracted_data, and "watcher_run_id": 100.',
        '4. Include this run_metadata object in complete_window exactly, and add any extra provider/job fields you know:',
        JSON.stringify(
          {
            executor: 'lobu-agent',
            agent_id: 'agent-1',
            watcher_run_id: 100,
            dispatch_source: 'scheduled',
            session_agent_id: 'session-agent-1',
          },
          null,
          2
        ),
        '',
        'If there is no content, do not fabricate results.',
      ].join('\n')
    );
  });

  it('a payload with no kind at all (pre-Task-3 shape) behaves identically to kind="knowledge"', () => {
    // parseWatcherRunPayload always coerces to a concrete kind before this
    // function ever sees the payload, but buildDispatchMessage itself must
    // not special-case digest unless explicitly told to.
    const payload = basePayload();
    // @ts-expect-error — simulate a payload object missing `kind` entirely.
    delete payload.kind;

    const withKnowledge = buildDispatchMessage({ ...baseParams, payload: basePayload({ kind: 'knowledge' }) });
    const withoutKind = buildDispatchMessage({ ...baseParams, payload });

    expect(withoutKind).toBe(withKnowledge);
  });
});

describe('watcherRunSucceedsWithoutWindow — onResolve fail-closed branch', () => {
  it('treats a digest run finished without a window as SUCCESS', () => {
    expect(watcherRunSucceedsWithoutWindow('digest')).toBe(true);
  });

  it('keeps a knowledge run finished without a window as a FAILURE (fail-closed)', () => {
    expect(watcherRunSucceedsWithoutWindow('knowledge')).toBe(false);
  });
});

describe('preflightDigestWatcherMcp — local config check, no live remote tools/list', () => {
  function fakeConfigService(serverIds: string[]) {
    return {
      async getAllHttpServers(_agentId?: string) {
        return new Map(serverIds.map((id) => [id, { id } as never]));
      },
    };
  }

  it('passes when the agent has the ShiFu Toolbox MCP configured', async () => {
    const result = await preflightDigestWatcherMcp({
      agentId: 'agent-1',
      configService: fakeConfigService(['shifu-toolbox', 'lobu-memory']),
    });
    expect(result).toEqual({ ok: true });
  });

  it('fails when the agent has no ShiFu Toolbox MCP configured', async () => {
    const result = await preflightDigestWatcherMcp({
      agentId: 'agent-1',
      configService: fakeConfigService(['lobu-memory']),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ShiFu Toolbox MCP/);
    }
  });
});
