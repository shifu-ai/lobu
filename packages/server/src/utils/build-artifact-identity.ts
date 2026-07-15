import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export const LOBU_BUILD_CAPABILITIES = ["agent-release.readiness.v1"] as const;

/** Canonical contract shared with Toolbox build-artifact receipt verification. */
export function computeLobuBuildIdentityDigest(input: {
  sourceRevision: string;
  buildTime: string;
  imageDigest: string;
  capabilities?: readonly string[];
}): string {
  const capabilities = [
    ...(input.capabilities ?? LOBU_BUILD_CAPABILITIES),
  ].sort();
  const bytes = canonicalize({
    sourceRevision: input.sourceRevision,
    buildTime: input.buildTime,
    imageDigest: input.imageDigest,
    capabilities,
  });
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
