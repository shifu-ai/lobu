import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = `sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);
const BUILD_TIME = "2026-07-15T00:00:00.000Z";
const SOURCE = "https://github.com/shifu-ai/lobu";
const WORKFLOW = ".github/workflows/build-images.yml";
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("public Lobu OCI image identity verifier CLI", () => {
  it("allows a correctly labeled multi-platform index", async () => {
    const result = await run(fixture());
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(result.output, "utf8"))).toEqual({ schemaVersion: 1, status: "verified",
      imageReference: `ghcr.io/shifu-ai/lobu-app@${ROOT}`, artifactDigest: ROOT, sourceRevision: REVISION,
      buildTime: BUILD_TIME, source: SOURCE, workflow: WORKFLOW, platformCount: 2 });
  });

  it.each([
    ["an old existing digest with the wrong revision label", fixture({ revisions: ["c".repeat(40), "c".repeat(40)] })],
    ["one mismatched platform", fixture({ revisions: [REVISION, "c".repeat(40)] })],
    ["a digest response header mismatch", fixture({ rootHeader: `sha256:${"d".repeat(64)}` })],
    ["an attestation-only index", fixture({ attestationOnly: true })],
    ["duplicate platform descriptors", fixture({ duplicatePlatform: true })],
    ["an excessive platform set", fixture({ platformCount: 5 })],
    ["an oversized response", fixture({ oversized: true })],
    ["a slow response", fixture({ slow: true })],
  ])("rejects %s and emits no verified artifact", async (_label, registry) => {
    const result = await run(registry);
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(result.output)).toThrow();
    expect(result.stdout).not.toContain('"status":"verified"');
  });
});

async function run(registry: ReturnType<typeof fixture>) {
  const server = createServer(registry.handler); servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server unavailable");
  const directory = mkdtempSync(join(tmpdir(), "lobu-oci-verifier-")); directories.push(directory);
  const output = join(directory, "verified.json");
  const child = spawn("node", [resolve("scripts/verify-lobu-oci-image-identity.mjs"),
    "--image-reference", `ghcr.io/shifu-ai/lobu-app@${ROOT}`,
    "--expected-source-revision", REVISION, "--expected-build-time", BUILD_TIME,
    "--expected-source", SOURCE, "--expected-workflow", WORKFLOW, "--verified-output", output,
    "--registry-base-url", `http://127.0.0.1:${address.port}`], { env: { ...process.env,
      LOBU_OCI_VERIFIER_ALLOW_TEST_REGISTRY: "1", LOBU_OCI_VERIFIER_TIMEOUT_MS: "50" } });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, stdout, stderr, output };
}

function fixture(options: { revisions?: string[]; rootHeader?: string; attestationOnly?: boolean;
  duplicatePlatform?: boolean; platformCount?: number; oversized?: boolean; slow?: boolean } = {}) {
  const count = options.platformCount ?? 2;
  const descriptors = Array.from({ length: count }, (_, index) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json", digest: digest(index + 1), size: 512,
    platform: options.attestationOnly ? { architecture: "unknown", os: "unknown" }
      : { architecture: options.duplicatePlatform ? "amd64" : index === 0 ? "amd64" : `arm64${index}`,
        os: "linux" },
    ...(options.attestationOnly ? { annotations: { "vnd.docker.reference.type": "attestation-manifest" } } : {}),
  }));
  const routes = new Map<string, { body: unknown; digest?: string; delay?: number }>();
  routes.set(`/v2/shifu-ai/lobu-app/manifests/${ROOT}`, { body: options.oversized ? { junk: "x".repeat(140_000) }
    : { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: descriptors },
    digest: options.rootHeader ?? ROOT, delay: options.slow ? 100 : 0 });
  descriptors.forEach((descriptor, index) => {
    routes.set(`/v2/shifu-ai/lobu-app/manifests/${descriptor.digest}`, { body: { schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest(index + 100), size: 256 },
      layers: [] }, digest: descriptor.digest });
    routes.set(`/v2/shifu-ai/lobu-app/blobs/${digest(index + 100)}`, { body: { architecture: "amd64", os: "linux",
      config: { Labels: labels(options.revisions?.[index] ?? REVISION) } } });
  });
  return { handler: (request: Parameters<Parameters<typeof createServer>[0]>[0],
    response: Parameters<Parameters<typeof createServer>[0]>[1]) => {
    const route = routes.get(request.url ?? "");
    if (!route) { response.writeHead(404).end(); return; }
    const body = JSON.stringify(route.body);
    const send = () => { response.writeHead(200, { "content-type": "application/json",
      "content-length": Buffer.byteLength(body), ...(route.digest ? { "docker-content-digest": route.digest } : {}) });
    response.end(body); };
    if (route.delay) setTimeout(send, route.delay); else send();
  } };
}

function labels(revision: string) {
  return { "org.opencontainers.image.revision": revision, "org.opencontainers.image.created": BUILD_TIME,
    "org.opencontainers.image.source": SOURCE, "io.shifu.release.workflow": WORKFLOW };
}
function digest(seed: number) { return `sha256:${seed.toString(16).padStart(64, "0")}`; }
