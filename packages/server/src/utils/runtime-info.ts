import packageJson from "../../package.json";
import {
  computeLobuBuildIdentityDigest,
  LOBU_BUILD_CAPABILITIES,
} from "./build-artifact-identity";

/** Stable capabilities attested by the deployed Lobu runtime carrier. */
export const RUNTIME_CARRIER_CAPABILITIES = [
  "lobu-runtime:member-schedule-direct-auth.v1",
  "lobu-runtime:automation-tool-catalog.v1",
  "lobu-runtime:turn.release_context.v1",
  "lobu-runtime:course_context_projection.v2",
] as const;

interface RuntimeEnvLike {
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  APP_GIT_SHA?: string;
  APP_BUILD_TIME?: string;
  APP_DECLARED_IMAGE_DIGEST?: string;
  SHIFU_MEMBER_AGENT_DIRECT_AUTH?: string;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function resolveRuntimeEnvironment(env?: RuntimeEnvLike | null): string {
  return (
    cleanString(env?.ENVIRONMENT) ||
    cleanString(env?.NODE_ENV) ||
    cleanString(process.env.ENVIRONMENT) ||
    cleanString(process.env.NODE_ENV) ||
    "development"
  );
}

export function getRuntimeInfo(env?: RuntimeEnvLike | null) {
  const memberScheduleDirectAuth =
    cleanString(env?.SHIFU_MEMBER_AGENT_DIRECT_AUTH) ??
    cleanString(process.env.SHIFU_MEMBER_AGENT_DIRECT_AUTH);
  const revision =
    cleanString(env?.APP_GIT_SHA) ||
    cleanString(process.env.APP_GIT_SHA) ||
    "unknown";
  const buildTime =
    cleanString(env?.APP_BUILD_TIME) ||
    cleanString(process.env.APP_BUILD_TIME) ||
    null;
  const imageDigestCandidate =
    cleanString(env?.APP_DECLARED_IMAGE_DIGEST) ||
    cleanString(process.env.APP_DECLARED_IMAGE_DIGEST);
  const declaredImageDigest =
    imageDigestCandidate && /^sha256:[0-9a-f]{64}$/.test(imageDigestCandidate)
      ? imageDigestCandidate
      : null;
  const production = resolveRuntimeEnvironment(env) === "production";
  const buildIdentityStatus =
    !production ||
    (revision !== "unknown" &&
      buildTime !== null &&
      declaredImageDigest !== null)
      ? "green"
      : "red";
  const buildIdentityDigest = computeLobuBuildIdentityDigest({
    sourceRevision: revision,
    buildTime: buildTime ?? "",
    imageDigest: declaredImageDigest ?? "",
    capabilities: LOBU_BUILD_CAPABILITIES,
  });
  return {
    version: packageJson.version,
    revision,
    build_time: buildTime,
    declared_image_digest: declaredImageDigest,
    build_identity_status: buildIdentityStatus,
    build_identity_digest: buildIdentityDigest,
    environment: resolveRuntimeEnvironment(env),
    carrier_capabilities: RUNTIME_CARRIER_CAPABILITIES.filter(
      (capability) =>
        capability !== "lobu-runtime:member-schedule-direct-auth.v1" ||
        memberScheduleDirectAuth === "1"
    ),
  };
}
