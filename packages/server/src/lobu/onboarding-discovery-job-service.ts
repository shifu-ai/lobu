import { createHash } from 'node:crypto';

export type OnboardingDiscoveryJobRequest = {
  organizationId: string;
  toolboxUserId: string;
  projectProfileId: string;
  projectName: string;
};

export type OnboardingDiscoveryJobValidationResult =
  | { ok: true; request: OnboardingDiscoveryJobRequest }
  | {
      ok: false;
      errorCode:
        | 'missing_organization_id'
        | 'missing_toolbox_user_id'
        | 'missing_project_profile_id'
        | 'missing_project_name';
    };

export type OnboardingDiscoveryJobAcceptedResponse = {
  jobId: string;
  status: 'queued';
  idempotencyKey: string;
};

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function validateOnboardingDiscoveryJobRequest(
  input: unknown
): OnboardingDiscoveryJobValidationResult {
  const candidate = input as {
    organizationId?: unknown;
    toolboxUserId?: unknown;
    projectProfileId?: unknown;
    payload?: { projectName?: unknown };
  };

  const organizationId = readTrimmedString(candidate?.organizationId);
  if (!organizationId) return { ok: false, errorCode: 'missing_organization_id' };

  const toolboxUserId = readTrimmedString(candidate?.toolboxUserId);
  if (!toolboxUserId) return { ok: false, errorCode: 'missing_toolbox_user_id' };

  const projectProfileId = readTrimmedString(candidate?.projectProfileId);
  if (!projectProfileId) return { ok: false, errorCode: 'missing_project_profile_id' };

  const projectName = readTrimmedString(candidate?.payload?.projectName);
  if (!projectName) return { ok: false, errorCode: 'missing_project_name' };

  return {
    ok: true,
    request: {
      organizationId,
      toolboxUserId,
      projectProfileId,
      projectName,
    },
  };
}

export function buildOnboardingDiscoveryJobAcceptedResponse({
  agentId,
  idempotencyKey,
}: {
  agentId: string;
  idempotencyKey: string;
}): OnboardingDiscoveryJobAcceptedResponse {
  const digest = createHash('sha256')
    .update(`${agentId}:${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 24);

  return {
    jobId: `onboarding_discovery_job_${agentId}_${digest}`,
    status: 'queued',
    idempotencyKey,
  };
}
