import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The workflow publisher is an executable ESM script without declarations.
import { createUnsignedLobuBuildReceipt } from "../../../../../scripts/publish-agent-release-build-receipt.mjs";

describe("app image build receipt workflow", () => {
  it("embeds immutable source identity and publishes the post-push registry digest receipt", () => {
    const workflow = readFileSync(
      path.resolve(
        __dirname,
        "../../../../../.github/workflows/build-images.yml",
      ),
      "utf8",
    );
    expect(workflow).toContain("id: push-app");
    expect(workflow).toContain("APP_GIT_SHA=${{ github.sha }}");
    expect(workflow).toContain(
      "APP_BUILD_TIME=${{ needs.generate-tag.outputs.build_time }}",
    );
    expect(workflow).toContain(
      `build_time=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')`,
    );
    expect(workflow).not.toContain("%Y-%m-%dT%H:%M:%SZ");
    expect(workflow).toContain("${{ steps.push-app.outputs.digest }}");
    expect(workflow).toContain("name: lobu-app-image-receipt");
    expect(workflow).not.toMatch(/actions\/(?:upload|download)-artifact@v4(?:\s|$)/);
    expect(workflow).not.toMatch(/uses:\s+(?:actions|docker)\/[^@\s]+@v\d+/);
    expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("Verify immutable app image is pullable");
    expect(workflow).toContain("publish-agent-release-build-receipt.mjs");
    expect(workflow).toContain("sign-lobu-build-receipt:");
    expect(workflow).toContain("publish-lobu-build-receipt:");
    const buildJob = workflow.slice(
      workflow.indexOf("  build-app:"),
      workflow.indexOf("  sign-lobu-build-receipt:"),
    );
    expect(buildJob).not.toContain("RECEIPT_PRIVATE_KEY_PKCS8");
    const signerJob = workflow.slice(
      workflow.indexOf("  sign-lobu-build-receipt:"),
      workflow.indexOf("  publish-lobu-build-receipt:"),
    );
    expect(signerJob).not.toContain("actions/checkout");
    expect(signerJob).not.toContain("publish-agent-release-build-receipt.mjs");
    expect(signerJob).not.toContain("TOOLBOX_INTERNAL_SECRET");
    expect(signerJob).toContain("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(signerJob).toContain("name: lobu-app-image-receipt");
    expect(signerJob).toContain("receipt.sourceRevision !== process.env.GITHUB_SHA");
    expect(signerJob).toContain("receipt.provenance.runId !== process.env.GITHUB_RUN_ID");
    expect(signerJob).toContain("receipt.provenance.runAttempt !== process.env.GITHUB_RUN_ATTEMPT");
    expect(signerJob).toContain("receipt.signing.keyId !== 'pending-protected-signer'");
    expect(signerJob).toContain("receipt.signing.keyId = process.env.RECEIPT_KEY_ID");
    expect(signerJob).toContain("fetchRegistryJson(`manifests/${expectedDigest}`");
    expect(signerJob).toContain("receipt.artifactIdentity");
    expect(workflow).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    expect(workflow).toContain("org.opencontainers.image.created=${{ needs.generate-tag.outputs.build_time }}");
    expect(workflow).toContain("org.opencontainers.image.source=https://github.com/${{ github.repository }}");
    expect(workflow).toContain("io.shifu.release.workflow=.github/workflows/build-images.yml");
    expect(signerJob).toContain("fetchRegistryJson");
    expect(signerJob).toContain("registryLabels");
    expect(signerJob).toContain("labels['org.opencontainers.image.revision'] !== process.env.GITHUB_SHA");
    expect(signerJob).toContain("labels['org.opencontainers.image.created'] !== receipt.buildTime");
    expect(signerJob).toContain("labels['org.opencontainers.image.source'] !== 'https://github.com/shifu-ai/lobu'");
    expect(signerJob).toContain("labels['io.shifu.release.workflow'] !== '.github/workflows/build-images.yml'");
    const publisherJob = workflow.slice(
      workflow.indexOf("  publish-lobu-build-receipt:"),
      workflow.indexOf("  build-worker:"),
    );
    expect(publisherJob).not.toContain("RECEIPT_PRIVATE_KEY_PKCS8");
    const producer = readFileSync(
      path.resolve(
        __dirname,
        "../../../../../scripts/publish-agent-release-build-receipt.mjs",
      ),
      "utf8",
    );
    expect(producer).toContain('purpose: "lobu_build_artifact_receipt"');
    expect(producer).toContain('scope: "global"');
    expect(producer).not.toContain('environment: "production"');
    expect(producer).toContain("imageDigest: artifactDigest");
    expect(producer).toContain(
      'workflow: ".github/workflows/build-images.yml"',
    );
    expect(producer).not.toContain("createPrivateKey");
    expect(producer).not.toContain("TOOLBOX_INTERNAL_SECRET");
    expect(workflow).not.toContain(
      "APP_DECLARED_IMAGE_DIGEST=${{ steps.push-app.outputs.digest }}",
    );
  });

  it("rejects substitution of an old existing registry digest before protected signing", () => {
    const workflow = readFileSync(path.resolve(__dirname,
      "../../../../../.github/workflows/build-images.yml"), "utf8");
    const signer = workflow.slice(workflow.indexOf("  sign-lobu-build-receipt:"),
      workflow.indexOf("  publish-lobu-build-receipt:"));
    expect(signer).toContain("receipt.sourceRevision !== process.env.GITHUB_SHA");
    expect(signer).toContain("labels['org.opencontainers.image.revision'] !== process.env.GITHUB_SHA");
    expect(signer.indexOf("registry label mismatch")).toBeLessThan(signer.indexOf("const key = createPrivateKey"));
    expect(signer.indexOf("registry label mismatch")).toBeLessThan(signer.indexOf("receipt.signing.signature"));
  });

  it("emits the exact v1 build-artifact payload without a second capability field", () => {
    const artifactDigest = `sha256:${"b".repeat(64)}`;
    const receipt = createUnsignedLobuBuildReceipt({
      sourceRevision: "a".repeat(40),
      artifactDigest,
      artifactIdentity: `ghcr.io/shifu-ai/lobu-app@${artifactDigest}`,
      buildTime: "2026-07-15T00:00:00.000Z",
      observedAt: "2026-07-15T01:00:00.000Z",
      runId: "123",
      runAttempt: "2",
      keyId: "pending-protected-signer",
    });
    expect(Object.keys(receipt).sort()).toEqual(
      [
        "receiptKind",
        "scope",
        "dependencyId",
        "sourceRevision",
        "artifactIdentity",
        "artifactDigest",
        "buildTime",
        "origin",
        "provides",
        "requires",
        "buildIdentityDigest",
        "provenance",
        "observedAt",
        "expiresAt",
        "signing",
      ].sort(),
    );
    expect(receipt).not.toHaveProperty("capabilities");
    expect(receipt.provides).toEqual(["agent-release.readiness.v1"]);
    expect(receipt.buildTime).toBe("2026-07-15T00:00:00.000Z");
    expect(receipt.expiresAt).toBe("2026-07-17T01:00:00.000Z");
    expect(() =>
      createUnsignedLobuBuildReceipt({
        sourceRevision: "a".repeat(40),
        artifactDigest,
        artifactIdentity: `ghcr.io/shifu-ai/lobu-app@${artifactDigest}`,
        buildTime: "2026-07-15T00:00:00Z",
        observedAt: "2026-07-15T01:00:00.000Z",
        runId: "123",
        runAttempt: "2",
        keyId: "pending-protected-signer",
      }),
    ).toThrow(/build time identity/);
    expect(() => createUnsignedLobuBuildReceipt({
      sourceRevision: "a".repeat(40), artifactDigest,
      artifactIdentity: `ghcr.io/attacker/lobu-app@${artifactDigest}`,
      buildTime: "2026-07-15T00:00:00.000Z", observedAt: "2026-07-15T01:00:00.000Z",
      runId: "123", runAttempt: "2", keyId: "pending-protected-signer",
    })).toThrow(/artifact identity/);
    expect(() => createUnsignedLobuBuildReceipt({
      sourceRevision: "a".repeat(40), artifactDigest,
      artifactIdentity: `ghcr.io/shifu-ai/lobu-app@${artifactDigest}`,
      buildTime: "2026-07-15T00:00:00.000Z", observedAt: "2026-07-15T01:00:00.000Z",
      runId: "fake-run", runAttempt: "2", keyId: "pending-protected-signer",
    })).toThrow(/workflow identity/);
  });
});
