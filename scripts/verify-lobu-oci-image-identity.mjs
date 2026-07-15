#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  args.set(process.argv[index], process.argv[index + 1]);
const allowed = new Set([
  "--image-reference",
  "--expected-source-revision",
  "--expected-build-time",
  "--expected-source",
  "--expected-workflow",
  "--verified-output",
  "--registry-base-url",
]);
if (
  process.argv.length % 2 !== 0 ||
  [...args.keys()].some((key) => !allowed.has(key)) ||
  [...args.values()].some((value) => !value)
)
  fail("usage_invalid");

const imageReference = required("--image-reference");
const match = imageReference.match(
  /^ghcr\.io\/shifu-ai\/lobu-app@(sha256:[0-9a-f]{64})$/
);
if (!match) fail("image_reference_invalid");
const artifactDigest = match[1];
const sourceRevision = required("--expected-source-revision");
const buildTime = required("--expected-build-time");
const source = required("--expected-source");
const workflow = required("--expected-workflow");
if (
  !/^[0-9a-f]{40}$/.test(sourceRevision) ||
  !canonicalTimestamp(buildTime) ||
  source !== "https://github.com/shifu-ai/lobu" ||
  workflow !== ".github/workflows/build-images.yml"
) {
  fail("expected_identity_invalid");
}
const registryBase = args.get("--registry-base-url") ?? "https://ghcr.io";
if (
  registryBase !== "https://ghcr.io" &&
  process.env.LOBU_OCI_VERIFIER_ALLOW_TEST_REGISTRY !== "1"
) {
  fail("registry_origin_invalid");
}
const timeoutMs =
  registryBase === "https://ghcr.io"
    ? 15_000
    : canonicalTimeout(process.env.LOBU_OCI_VERIFIER_TIMEOUT_MS);

try {
  const platformLabels = await readPlatformLabels(artifactDigest);
  for (const labels of platformLabels) {
    if (
      labels["org.opencontainers.image.revision"] !== sourceRevision ||
      labels["org.opencontainers.image.created"] !== buildTime ||
      labels["org.opencontainers.image.source"] !== source ||
      labels["io.shifu.release.workflow"] !== workflow
    )
      fail("registry_label_mismatch");
  }
  const verified = {
    schemaVersion: 1,
    status: "verified",
    imageReference,
    artifactDigest,
    sourceRevision,
    buildTime,
    source,
    workflow,
    platformCount: platformLabels.length,
  };
  const output = `${JSON.stringify(verified)}\n`;
  await writeFile(required("--verified-output"), output, { flag: "wx" });
  process.stdout.write(output);
} catch (error) {
  fail(error instanceof Error ? error.message : "verification_failed");
}

async function readPlatformLabels(expectedDigest) {
  const root = await fetchRegistryJson(
    `manifests/${expectedDigest}`,
    128 * 1024,
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    expectedDigest
  );
  let manifests = [root];
  if (Array.isArray(root.manifests)) {
    const descriptors = root.manifests.filter(
      (item) =>
        item?.platform?.architecture !== "unknown" &&
        item?.annotations?.["vnd.docker.reference.type"] !==
          "attestation-manifest"
    );
    if (descriptors.length < 1 || descriptors.length > 4)
      throw new Error("registry_platform_set_invalid");
    const platforms = new Set();
    manifests = [];
    for (const descriptor of descriptors) {
      if (
        !plain(descriptor) ||
        !digest(descriptor.digest) ||
        !plain(descriptor.platform) ||
        typeof descriptor.platform.os !== "string" ||
        typeof descriptor.platform.architecture !== "string"
      ) {
        throw new Error("registry_descriptor_invalid");
      }
      const platform = `${descriptor.platform.os}/${descriptor.platform.architecture}/${descriptor.platform.variant ?? ""}`;
      if (platforms.has(platform))
        throw new Error("registry_platform_duplicate");
      platforms.add(platform);
      manifests.push(
        await fetchRegistryJson(
          `manifests/${descriptor.digest}`,
          128 * 1024,
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          descriptor.digest
        )
      );
    }
  }
  const results = [];
  for (const manifest of manifests) {
    if (
      manifest.schemaVersion !== 2 ||
      !plain(manifest.config) ||
      !digest(manifest.config.digest) ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length > 256
    )
      throw new Error("registry_manifest_invalid");
    const config = await fetchRegistryJson(
      `blobs/${manifest.config.digest}`,
      256 * 1024,
      "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json"
    );
    const labels = config?.config?.Labels;
    if (
      !plain(labels) ||
      Object.keys(labels).length > 128 ||
      Object.entries(labels).some(
        ([key, value]) =>
          key.length > 256 || typeof value !== "string" || value.length > 2048
      )
    )
      throw new Error("registry_labels_invalid");
    results.push(labels);
  }
  return results;
}

async function fetchRegistryJson(path, maxBytes, accept, expectedDigest) {
  const url = `${registryBase}/v2/shifu-ai/lobu-app/${path}`;
  let response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    await response.body?.cancel();
    const token = challenge.match(
      /^Bearer realm="(https:\/\/ghcr\.io\/token)",service="(ghcr\.io)",scope="(repository:shifu-ai\/lobu-app:pull)"$/
    );
    if (!token) throw new Error("registry_auth_challenge_invalid");
    const tokenBody = await boundedJson(
      await fetch(
        `${token[1]}?service=${encodeURIComponent(token[2])}&scope=${encodeURIComponent(token[3])}`,
        { signal: AbortSignal.timeout(timeoutMs) }
      ),
      16 * 1024
    );
    if (
      !plain(tokenBody) ||
      typeof tokenBody.token !== "string" ||
      tokenBody.token.length > 8192
    ) {
      throw new Error("registry_token_invalid");
    }
    response = await fetch(url, {
      headers: { accept, authorization: `Bearer ${tokenBody.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  if (
    expectedDigest &&
    response.headers.get("docker-content-digest") !== expectedDigest
  ) {
    await response.body?.cancel();
    throw new Error("registry_digest_mismatch");
  }
  return boundedJson(response, maxBytes);
}

async function boundedJson(response, maxBytes) {
  if (!response.ok || !response.body)
    throw new Error("registry_response_unavailable");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel();
    throw new Error("registry_response_too_large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("registry_response_too_large");
    }
    chunks.push(item.value);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("registry_response_json_invalid");
  }
  if (!plain(value)) throw new Error("registry_response_invalid");
  return value;
}

function required(name) {
  const value = args.get(name);
  if (!value) fail("usage_invalid");
  return value;
}
function plain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function digest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function canonicalTimestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function canonicalTimeout(value) {
  return typeof value === "string" && /^\d{1,5}$/.test(value)
    ? Math.max(10, Number(value))
    : 100;
}
function fail(reason) {
  process.stderr.write(`status=failed reason=${reason}\n`);
  process.exit(1);
}
