import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );

export function createUnsignedLobuBuildReceipt(input) {
  const {
    sourceRevision,
    artifactDigest,
    buildTime,
    artifactIdentity,
    observedAt,
  } = input;
  if (
    !/^[0-9a-f]{40}$/.test(sourceRevision) ||
    !/^sha256:[0-9a-f]{64}$/.test(artifactDigest) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(buildTime)
  ) {
    throw new Error("invalid immutable Lobu artifact or build time identity");
  }
  const provides = ["agent-release.readiness.v1"];
  const buildIdentityDigest = `sha256:${createHash("sha256")
    .update(
      canonical({
        sourceRevision,
        buildTime,
        imageDigest: artifactDigest,
        capabilities: provides,
      })
    )
    .digest("hex")}`;
  return {
    receiptKind: "build_artifact",
    scope: "global",
    dependencyId: "lobu-runtime",
    sourceRevision,
    artifactIdentity,
    artifactDigest,
    buildTime,
    origin: "ghcr.io/shifu-ai/lobu-app",
    provides,
    requires: [],
    buildIdentityDigest,
    provenance: {
      provider: "github-actions",
      repository: "shifu-ai/lobu",
      workflow: ".github/workflows/build-images.yml",
      ref: "refs/heads/main",
      runId: input.runId,
      runAttempt: input.runAttempt,
      conclusion: "success",
      environmentProtected: true,
      breakGlass: false,
    },
    observedAt,
    expiresAt: new Date(
      Date.parse(observedAt) + 48 * 60 * 60 * 1000
    ).toISOString(),
    signing: {
      algorithm: "Ed25519",
      keyId: input.keyId,
      purpose: "lobu_build_artifact_receipt",
    },
  };
}

async function main() {
  const unsigned = createUnsignedLobuBuildReceipt({
    sourceRevision: required("GITHUB_SHA"),
    artifactDigest: required("IMAGE_DIGEST"),
    buildTime: required("BUILD_TIME"),
    artifactIdentity: required("IMAGE_REFERENCE"),
    observedAt: new Date().toISOString(),
    runId: required("GITHUB_RUN_ID"),
    runAttempt: required("GITHUB_RUN_ATTEMPT"),
    keyId: required("RECEIPT_KEY_ID"),
  });
  const output = `${canonical(unsigned)}\n`;
  if (Buffer.byteLength(output) > 32 * 1024)
    throw new Error("unsigned Lobu build receipt exceeds 32 KiB");
  process.stdout.write(output);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
