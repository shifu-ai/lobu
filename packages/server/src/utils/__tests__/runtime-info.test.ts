import { describe, expect, it } from "vitest";
import {
  getRuntimeInfo,
  resolveRuntimeEnvironment,
  RUNTIME_CARRIER_CAPABILITIES,
} from "../runtime-info";
import { computeLobuBuildIdentityDigest } from "../build-artifact-identity";

describe("resolveRuntimeEnvironment", () => {
  it("prefers ENVIRONMENT over NODE_ENV", () => {
    expect(
      resolveRuntimeEnvironment({
        ENVIRONMENT: "production",
        NODE_ENV: "development",
      })
    ).toBe("production");
  });

  it("falls back to NODE_ENV when ENVIRONMENT is missing", () => {
    expect(resolveRuntimeEnvironment({ NODE_ENV: "production" })).toBe(
      "production"
    );
  });
});

describe("getRuntimeInfo", () => {
  it("matches the Toolbox signed runtime-carrier capability contract", () => {
    expect(RUNTIME_CARRIER_CAPABILITIES).toEqual([
      "lobu-runtime:member-schedule-direct-auth.v1",
      "lobu-runtime:automation-tool-catalog.v1",
      "lobu-runtime:turn.release_context.v1",
      "lobu-runtime:course_context_projection.v2",
    ]);
  });

  it("returns revision and build metadata from env", () => {
    expect(
      getRuntimeInfo({
        NODE_ENV: "production",
        APP_GIT_SHA: "abc123",
        APP_BUILD_TIME: "2026-04-12T23:00:00Z",
        APP_DECLARED_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
        SHIFU_MEMBER_AGENT_DIRECT_AUTH: "1",
      })
    ).toMatchObject({
      environment: "production",
      revision: "abc123",
      build_time: "2026-04-12T23:00:00Z",
      declared_image_digest: `sha256:${"a".repeat(64)}`,
      build_identity_status: "green",
      build_identity_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      carrier_capabilities: [
        "lobu-runtime:member-schedule-direct-auth.v1",
        "lobu-runtime:automation-tool-catalog.v1",
        "lobu-runtime:turn.release_context.v1",
        "lobu-runtime:course_context_projection.v2",
      ],
    });
  });

  it("uses the canonical global build-artifact identity formula shared with Toolbox", () => {
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const runtime = getRuntimeInfo({
      NODE_ENV: "production",
      APP_GIT_SHA: "b".repeat(40),
      APP_BUILD_TIME: "2026-07-15T10:00:00.000Z",
      APP_DECLARED_IMAGE_DIGEST: imageDigest,
    });
    expect(runtime.build_identity_digest).toBe(
      computeLobuBuildIdentityDigest({
        sourceRevision: "b".repeat(40),
        buildTime: "2026-07-15T10:00:00.000Z",
        imageDigest,
      })
    );
  });

  it("fails the bounded build identity closed in production when metadata is absent", () => {
    expect(getRuntimeInfo({ NODE_ENV: "production" })).toMatchObject({
      revision: "unknown",
      build_time: null,
      declared_image_digest: null,
      build_identity_status: "red",
    });
  });

  it("does not accept a mutable tag as a declared immutable image digest", () => {
    expect(
      getRuntimeInfo({
        NODE_ENV: "production",
        APP_GIT_SHA: "abc123",
        APP_BUILD_TIME: "2026-04-12T23:00:00Z",
        APP_DECLARED_IMAGE_DIGEST: "ghcr.io/shifu-ai/lobu-app:latest",
      })
    ).toMatchObject({
      declared_image_digest: null,
      build_identity_status: "red",
    });
  });

  it("only advertises member schedule direct auth when the runtime flag is enabled", () => {
    expect(
      getRuntimeInfo({ SHIFU_MEMBER_AGENT_DIRECT_AUTH: "1" })
        .carrier_capabilities
    ).toContain("lobu-runtime:member-schedule-direct-auth.v1");
    expect(
      getRuntimeInfo({ SHIFU_MEMBER_AGENT_DIRECT_AUTH: "0" })
        .carrier_capabilities
    ).not.toContain("lobu-runtime:member-schedule-direct-auth.v1");
    expect(getRuntimeInfo({}).carrier_capabilities).not.toContain(
      "lobu-runtime:member-schedule-direct-auth.v1"
    );
  });
});
