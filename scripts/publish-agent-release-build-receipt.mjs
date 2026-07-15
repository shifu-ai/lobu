import { createHash, createPrivateKey, sign } from "node:crypto";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const canonical = (value) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item);

const sourceRevision = required("GITHUB_SHA");
const artifactDigest = required("IMAGE_DIGEST");
const buildTime = required("BUILD_TIME");
const artifactIdentity = required("IMAGE_REFERENCE");
if (!/^[0-9a-f]{40}$/.test(sourceRevision) || !/^sha256:[0-9a-f]{64}$/.test(artifactDigest)) {
  throw new Error("invalid immutable Lobu artifact identity");
}
const buildIdentityDigest = `sha256:${createHash("sha256").update(JSON.stringify({
  buildSource: "github:shifu-ai/lobu", revision: sourceRevision, buildTime,
  declaredImageDigest: artifactDigest, capabilities: ["agent-release.readiness.v1"],
})).digest("hex")}`;
const observedAt = new Date().toISOString();
const expiresAt = new Date(Date.parse(observedAt) + 48 * 60 * 60 * 1000).toISOString();
const signing = { algorithm: "Ed25519", keyId: required("RECEIPT_KEY_ID"),
  purpose: "lobu_build_artifact_receipt" };
const unsigned = { receiptKind: "build_artifact", environment: "production", dependencyId: "lobu-runtime",
  sourceRevision, artifactIdentity, artifactDigest, origin: "ghcr.io/shifu-ai/lobu-app",
  provides: ["agent-release.readiness.v1"], requires: [], buildIdentityDigest,
  provenance: { provider: "github-actions", repository: "shifu-ai/lobu",
    workflow: ".github/workflows/build-images.yml", ref: "refs/heads/main",
    runId: required("GITHUB_RUN_ID"), runAttempt: required("GITHUB_RUN_ATTEMPT"), conclusion: "success",
    environmentProtected: true, breakGlass: false }, observedAt, expiresAt, signing };
const key = createPrivateKey({ key: Buffer.from(required("RECEIPT_PRIVATE_KEY_PKCS8"), "base64"),
  format: "der", type: "pkcs8" });
const signature = sign(null, Buffer.from(canonical(unsigned)), key).toString("base64");
const receipt = { ...unsigned, signing: { ...signing, signature } };
const body = canonical({ receipt });
const url = required("TOOLBOX_RECEIPT_INGRESS_URL");
const secret = required("TOOLBOX_INTERNAL_SECRET");
let response;
for (let attempt = 1; attempt <= 5; attempt++) {
  response = await fetch(url, { method: "POST", headers: { "content-type": "application/json",
    "x-internal-secret": secret }, body });
  if (response.ok) break;
  if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
}
if (!response?.ok) throw new Error(`receipt ingress failed (${response?.status ?? "no_response"})`);
process.stdout.write(`${canonical(receipt)}\n`);
