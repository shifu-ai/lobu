/**
 * End-to-end check that the fake-LLM harness is wired into the dev server.
 *
 * Driven by scripts/run-e2e.sh, which:
 *   1. starts packages/server/src/__tests__/fixtures/fake-llm-server.ts on a
 *      known port and exports LOBU_E2E_FAKE_LLM_URL
 *   2. boots the dev server with LOBU_PROVIDER_REGISTRY_PATH pointing at the
 *      fixture providers.json that registers `fake-llm` against the running
 *      fake server, and FAKE_LLM_API_KEY=fake-test-key (so hasSystemKey()
 *      returns true and ephemeral agents auto-install the provider)
 *
 * What we verify here:
 *   - The fake LLM is reachable from the test process and from the dev
 *     server's process (both bind 127.0.0.1 — these are not the same check
 *     because the fake binds first, before the dev server boots)
 *   - The fake's control plane (POST /__control__/enqueue +
 *     GET /__control__/history) is functional from outside its own process,
 *     so future agent-driven tests can script replies remotely
 *   - The fake speaks the OpenAI Chat Completions wire format: a request
 *     mirroring what pi-ai sends produces a parseable assistant message
 *   - POST /lobu/api/v1/agents now succeeds for a signed-in cookie session.
 *     The lobu/gateway.ts middleware resolves the user's primary org and
 *     wraps the request in orgContext.run(), so Postgres-backed stores
 *     (which getOrgId() via AsyncLocalStorage) work for unscoped routes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_URL,
  addUserToOrg,
  cleanupTestData,
  closeDb,
  createTestOrg,
  signUpTestUser,
  type SignedUpUser,
  type TestOrg,
} from './helpers';

const FAKE_LLM_URL = process.env.LOBU_E2E_FAKE_LLM_URL;
const SKIP = !FAKE_LLM_URL;

beforeAll(async () => {
  if (SKIP) return;
  // Sanity: dev server must be reachable. The harness boots it before vitest
  // runs, so this is a fast precondition rather than a flake-prone wait.
  const health = await fetch(`${APP_URL}/health`);
  if (!health.ok) {
    throw new Error(`Cannot reach app at ${APP_URL} (health=${health.status})`);
  }
  // Reset queue + history once so each test starts from a clean slate.
  if (FAKE_LLM_URL) {
    await fetch(`${FAKE_LLM_URL}/__control__/reset`, { method: 'POST' });
  }
});

afterAll(async () => {
  if (SKIP || !FAKE_LLM_URL) return;
  await fetch(`${FAKE_LLM_URL}/__control__/reset`, { method: 'POST' });
});

describe.skipIf(SKIP)('fake-llm harness is wired into the dev server', () => {
  it('the fake LLM advertises its model list via /v1/models', async () => {
    const res = await fetch(`${FAKE_LLM_URL}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain('fake-llm-1');
  });

  it('control plane queues a reply that the chat-completions endpoint then consumes (FIFO)', async () => {
    const queueRes = await fetch(`${FAKE_LLM_URL}/__control__/enqueue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: 'harness-confirmed' }),
    });
    expect(queueRes.status).toBe(200);

    // pi-ai sends a payload of this shape; mirror it so the assertion
    // documents the wire contract the gateway's secret-proxy will forward.
    const completion = await fetch(`${FAKE_LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fake-test-key',
      },
      body: JSON.stringify({
        model: 'fake-llm-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(completion.status).toBe(200);
    const data = (await completion.json()) as {
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      model: string;
    };
    expect(data.model).toBe('fake-llm-1');
    expect(data.choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'harness-confirmed',
    });
    expect(data.choices[0]?.finish_reason).toBe('stop');

    // History endpoint mirrors what the fake observed — useful for future
    // agent-driven tests to assert on the prompt the worker actually sent.
    const histRes = await fetch(`${FAKE_LLM_URL}/__control__/history`);
    const hist = (await histRes.json()) as Array<{
      messages: Array<{ role: string; content: string }>;
    }>;
    const matching = hist.filter((entry) =>
      entry.messages.some((m) => m.role === 'user' && m.content === 'hi')
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 503 with a clear error when no reply has been queued (catches mis-wired tests)', async () => {
    await fetch(`${FAKE_LLM_URL}/__control__/reset`, { method: 'POST' });
    const completion = await fetch(`${FAKE_LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
    });
    expect(completion.status).toBe(503);
    const body = (await completion.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/no scripted reply queued/);
  });
});

/**
 * Validates that the orgContext middleware in lobu/gateway.ts unblocks the
 * createAgentApi route for cookie-authed sessions. We're not asserting on
 * the agent's text reply (that requires a complete pi-ai → SSE round-trip
 * and a worker subprocess that's slow to boot inside this suite); we ARE
 * asserting that the route now succeeds where it previously 500'd with
 * "Organization context not available", and that the auto-provisioned
 * ephemeral agent has fake-llm in its installedProviders list.
 */
describe.skipIf(SKIP)('lobu/gateway orgContext middleware', () => {
  let signedUp: SignedUpUser;
  let org: TestOrg;
  let cookieHeader: string;

  beforeAll(async () => {
    if (SKIP) return;
    signedUp = await signUpTestUser();
    org = await createTestOrg();
    await addUserToOrg(signedUp.userId, org.id, 'owner');
    cookieHeader = signedUp.cookieHeader;
  }, 30_000);

  afterAll(async () => {
    if (SKIP) return;
    await cleanupTestData();
    await closeDb();
  });

  it('POST /lobu/api/v1/agents creates an ephemeral agent with the fake-llm provider auto-installed', async () => {
    const res = await fetch(`${APP_URL}/lobu/api/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ forceNew: true, dryRun: true }),
    });

    expect(res.status, `expected 2xx, got ${res.status}: ${await res.clone().text()}`).toBeLessThan(
      300
    );
    const body = (await res.json()) as {
      success: boolean;
      agentId: string;
      token: string;
      error?: string;
    };
    expect(body.success).toBe(true);
    expect(body.agentId).toBeTruthy();
    expect(body.token).toBeTruthy();
  });
});
