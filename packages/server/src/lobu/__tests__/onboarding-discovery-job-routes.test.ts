import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  buildOnboardingDiscoveryJobAcceptedResponse,
  validateOnboardingDiscoveryJobRequest,
} from '../onboarding-discovery-job-service';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const VALID_REQUEST = {
  organizationId: 'org-onboarding',
  toolboxUserId: 'toolbox-user-1',
  projectProfileId: 'profile-1',
  payload: {
    projectName: 'ShiFu Agent Stack',
  },
};

function resetAuth(): void {
  authStash.user = {
    id: 'toolbox-server',
    name: 'Toolbox Server',
    email: 'toolbox@test.local',
    emailVerified: true,
  };
  authStash.organizationId = 'org-onboarding';
  authStash.authSource = 'pat';
  authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] };
  authStash.memberRole = null;
  authStash.rejectMcpAuth = false;
  authStash.mcpAuthCalls = 0;
}

async function importMountedAgentRoutes() {
  // Dynamic import after installRouteTestMocks() so agent-routes binds to the
  // shared route-test auth/store stubs.
  const { agentRoutes } = await import('../agent-routes.js');
  const app = new Hono();
  app.route('/api/v1/agents', agentRoutes);
  return app;
}

describe('onboarding discovery job service', () => {
  test('validateOnboardingDiscoveryJobRequest rejects missing projectName with missing_project_name', () => {
    const result = validateOnboardingDiscoveryJobRequest({
      ...VALID_REQUEST,
      payload: {},
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'missing_project_name',
    });
  });

  test('buildOnboardingDiscoveryJobAcceptedResponse builds queued response preserving idempotencyKey', () => {
    const response = buildOnboardingDiscoveryJobAcceptedResponse({
      agentId: 'shifu-u-user-1',
      idempotencyKey: 'route-key-123',
    });

    expect(response).toMatchObject({
      status: 'queued',
      idempotencyKey: 'route-key-123',
    });
    expect(response.jobId).toContain('onboarding_discovery_job_');
  });
});

describe('POST /agents/:agentId/onboarding/discovery-jobs', () => {
  beforeEach(() => {
    resetAuth();
  });

  test('rejects non personal-agent ids', async () => {
    const app = await importMountedAgentRoutes();

    const response = await app.request('/api/v1/agents/apply-agent/onboarding/discovery-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'route-key-123',
      },
      body: JSON.stringify(VALID_REQUEST),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_agent_id' });
  });

  test('returns accepted queued response for a valid request', async () => {
    const app = await importMountedAgentRoutes();

    const response = await app.request(
      '/api/v1/agents/shifu-u-user-1/onboarding/discovery-jobs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'route-key-123',
        },
        body: JSON.stringify(VALID_REQUEST),
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'queued',
      idempotencyKey: 'route-key-123',
    });
  });
});
