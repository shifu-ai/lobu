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
        "../../../../../.github/workflows/build-images.yml"
      ),
      "utf8"
    );
    expect(workflow).toContain("id: push-app");
    expect(workflow).toContain("APP_GIT_SHA=${{ github.sha }}");
    expect(workflow).toContain(
      "APP_BUILD_TIME=${{ needs.generate-tag.outputs.build_time }}"
    );
    expect(workflow).toContain("${{ steps.push-app.outputs.digest }}");
    expect(workflow).toContain("name: lobu-app-image-receipt");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("Verify immutable app image is pullable");
    expect(workflow).toContain("publish-agent-release-build-receipt.mjs");
    expect(workflow).toContain(
      "AGENT_RELEASE_LOBU_BUILD_RECEIPT_PRIVATE_KEY_PKCS8"
    );
    const producer = readFileSync(
      path.resolve(
        __dirname,
        "../../../../../scripts/publish-agent-release-build-receipt.mjs"
      ),
      "utf8"
    );
    expect(producer).toContain('purpose: "lobu_build_artifact_receipt"');
    expect(producer).toContain('scope: "global"');
    expect(producer).not.toContain('environment: "production"');
    expect(producer).toContain("imageDigest: artifactDigest");
    expect(producer).toContain(
      'workflow: ".github/workflows/build-images.yml"'
    );
    expect(producer).toContain(
      "for (let attempt = 1; attempt <= 5; attempt++)"
    );
    expect(producer).toContain('"x-internal-secret": secret');
    expect(workflow).not.toContain(
      "APP_DECLARED_IMAGE_DIGEST=${{ steps.push-app.outputs.digest }}"
    );
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
      keyId: "lobu-build-key-v1",
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
      ].sort()
    );
    expect(receipt).not.toHaveProperty("capabilities");
    expect(receipt.provides).toEqual(["agent-release.readiness.v1"]);
  });
});
