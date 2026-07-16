import { describe, expect, it } from "vitest";
// @ts-expect-error The workflow publisher is an executable ESM script without declarations.
import { createUnsignedLobuBuildReceipt } from "../../../../../scripts/publish-agent-release-build-receipt.mjs";

describe("unsigned app image build receipt", () => {
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
