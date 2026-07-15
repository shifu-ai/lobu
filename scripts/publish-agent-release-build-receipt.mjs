import { createHash, createPrivateKey, sign } from "node:crypto";
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
    !/^sha256:[0-9a-f]{64}$/.test(artifactDigest)
  ) {
    throw new Error("invalid immutable Lobu artifact identity");
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
  const key = createPrivateKey({
    key: Buffer.from(required("RECEIPT_PRIVATE_KEY_PKCS8"), "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(canonical(unsigned)), key).toString(
    "base64"
  );
  const receipt = {
    ...unsigned,
    signing: { ...unsigned.signing, signature },
  };
  const body = canonical({ receipt });
  const url = required("TOOLBOX_RECEIPT_INGRESS_URL");
  const secret = required("TOOLBOX_INTERNAL_SECRET");
  let response;
  for (let attempt = 1; attempt <= 5; attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body,
    });
    if (response.ok) break;
    if (attempt < 5)
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  if (!response?.ok)
    throw new Error(
      `receipt ingress failed (${response?.status ?? "no_response"})`
    );
  process.stdout.write(`${canonical(receipt)}\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
