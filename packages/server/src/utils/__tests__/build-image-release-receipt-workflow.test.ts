import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The workflow publisher is an executable ESM script without declarations.
import { createUnsignedLobuBuildReceipt } from "../../../../../scripts/publish-agent-release-build-receipt.mjs";

const workflowPath = resolve(".github/workflows/build-images.yml");
const workflow = readFileSync(workflowPath, "utf8");
const directories: string[] = [];
const buildModeGuard =
	"github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'build')";
const exportModeGuard =
	"github.repository == 'shifu-ai/lobu' && github.event_name == 'workflow_dispatch' && inputs.mode == 'export_build_public_key' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/codex/build-receipt-public-key')";

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

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
		expect(() =>
			createUnsignedLobuBuildReceipt({
				sourceRevision: "a".repeat(40),
				artifactDigest,
				artifactIdentity: `ghcr.io/attacker/lobu-app@${artifactDigest}`,
				buildTime: "2026-07-15T00:00:00.000Z",
				observedAt: "2026-07-15T01:00:00.000Z",
				runId: "123",
				runAttempt: "2",
				keyId: "pending-protected-signer",
			}),
		).toThrow(/artifact identity/);
		expect(() =>
			createUnsignedLobuBuildReceipt({
				sourceRevision: "a".repeat(40),
				artifactDigest,
				artifactIdentity: `ghcr.io/shifu-ai/lobu-app@${artifactDigest}`,
				buildTime: "2026-07-15T00:00:00.000Z",
				observedAt: "2026-07-15T01:00:00.000Z",
				runId: "fake-run",
				runAttempt: "2",
				keyId: "pending-protected-signer",
			}),
		).toThrow(/workflow identity/);
	});
});

describe("build image workflow modes", () => {
	it("defaults to build and exposes only the closed build/public-key-export choices", () => {
		expect(workflow).toMatch(
			/mode:\n\s+description:.*\n\s+type: choice\n\s+options:\n\s+- build\n\s+- export_build_public_key\n\s+default: build/,
		);
	});

	it("keeps every build, signing, publishing, and notification job out of export mode", () => {
		for (const jobName of [
			"generate-tag",
			"connector-parity-smoke",
			"build-worker",
			"build-embeddings-service",
			"build-app",
			"sign-lobu-build-receipt",
			"publish-lobu-build-receipt",
		]) {
			expect(job(jobName), jobName).toContain(`if: \${{ ${buildModeGuard} }}`);
		}

		const notifier = job("notify-failure");
		expect(notifier).toContain("failure()");
		expect(notifier).toContain("github.ref == 'refs/heads/main'");
		expect(notifier).toContain(`(${buildModeGuard})`);
		expect(notifier).not.toContain("export_build_public_key");
	});

	it.each([
		[
			"a main push plans the unchanged build path",
			workflowContext({ eventName: "push", ref: "refs/heads/main" }),
			[
				"generate-tag",
				"connector-parity-smoke",
				"build-app",
				"sign-lobu-build-receipt",
				"publish-lobu-build-receipt",
				"build-worker",
				"build-embeddings-service",
			],
		],
		[
			"a manual build plans the unchanged build path",
			workflowContext({ mode: "build" }),
			[
				"generate-tag",
				"connector-parity-smoke",
				"build-app",
				"sign-lobu-build-receipt",
				"publish-lobu-build-receipt",
				"build-worker",
				"build-embeddings-service",
			],
		],
		[
			"a failed main build activates the failure notifier",
			workflowContext({
				eventName: "push",
				ref: "refs/heads/main",
				failed: true,
			}),
			[
				"generate-tag",
				"connector-parity-smoke",
				"build-app",
				"sign-lobu-build-receipt",
				"publish-lobu-build-receipt",
				"build-worker",
				"build-embeddings-service",
				"notify-failure",
			],
		],
		[
			"an export failure on the approved branch plans only export and never the notifier",
			workflowContext({ mode: "export_build_public_key", failed: true }),
			["export-lobu-build-public-key"],
		],
		[
			"an export failure on main plans only export and never the notifier",
			workflowContext({
				mode: "export_build_public_key",
				ref: "refs/heads/main",
				failed: true,
			}),
			["export-lobu-build-public-key"],
		],
		[
			"an export request from another ref plans no jobs",
			workflowContext({
				mode: "export_build_public_key",
				ref: "refs/heads/feature",
			}),
			[],
		],
	])("evaluates extracted guards and dependencies: %s", (_label, context, expected) => {
		expect(plannedJobs(context)).toEqual(expected);
	});

	it("preserves the build/sign/publish dependency gates and isolates export from them", () => {
		expect(job("build-worker")).toContain(
			"needs: [generate-tag, connector-parity-smoke]",
		);
		expect(job("build-embeddings-service")).toContain("needs: [generate-tag]");
		expect(job("build-app")).toContain(
			"needs: [generate-tag, build-worker, build-embeddings-service]",
		);
		const signer = job("sign-lobu-build-receipt");
		expect(signer).toContain("needs: [build-app]");
		expect(signer).toContain("process.env.GITHUB_REF !== 'refs/heads/main'");
		expect(job("publish-lobu-build-receipt")).toContain(
			"needs: [sign-lobu-build-receipt]",
		);

		const exporter = job("export-lobu-build-public-key");
		expect(exporter).toContain(`if: \${{ ${exportModeGuard} }}`);
		expect(exporter).not.toMatch(/^\s+needs:/m);
		expect(exporter).toContain("environment: production");
		expect(exporter).toMatch(/permissions:\n\s+contents: none/);
		expect(exporter).not.toContain("actions/checkout");
		expect(exporter).not.toMatch(/\b(?:curl|wget|npm|bun|pnpm|yarn|git)\b/);
	});
});

describe("protected Lobu build receipt public-key export", () => {
	it("exports an Ed25519 SPKI that verifies an existing-format signed receipt", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const privateKeyPkcs8Base64 = privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64");
		const result = runExporter({ privateKeyPkcs8Base64 });

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		const exported = JSON.parse(readFileSync(result.artifactPath, "utf8"));
		expect(Object.keys(exported).sort()).toEqual(
			[
				"algorithm",
				"fingerprint",
				"keyId",
				"publicKeySpkiBase64",
				"purpose",
				"schemaVersion",
			].sort(),
		);
		expect(exported.schemaVersion).toBe(1);
		expect(exported.algorithm).toBe("Ed25519");
		expect(exported.purpose).toBe("lobu_build_artifact_receipt");
		expect(exported.keyId).toBe("lobu-build-receipt-2026-01");
		expect(exported.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
		const publicKeySpki = Buffer.from(exported.publicKeySpkiBase64, "base64");
		expect(exported.fingerprint).toBe(
			`sha256:${createHash("sha256").update(publicKeySpki).digest("hex")}`,
		);
		const serializedArtifact = readFileSync(result.artifactPath, "utf8");
		expect(serializedArtifact).not.toContain(privateKeyPkcs8Base64);
		expect(serializedArtifact).not.toContain('"signature"');

		const receipt = createUnsignedLobuBuildReceipt({
			sourceRevision: "a".repeat(40),
			artifactDigest: `sha256:${"b".repeat(64)}`,
			artifactIdentity: `ghcr.io/shifu-ai/lobu-app@sha256:${"b".repeat(64)}`,
			buildTime: "2026-07-15T00:00:00.000Z",
			observedAt: "2026-07-15T01:00:00.000Z",
			runId: "123",
			runAttempt: "2",
			keyId: "pending-protected-signer",
		});
		receipt.signing.keyId = exported.keyId;
		const canonical = canonicalJson(receipt);
		const signature = sign(null, Buffer.from(canonical), privateKey);
		expect(
			verify(
				null,
				Buffer.from(canonical),
				{
					key: publicKeySpki,
					format: "der",
					type: "spki",
				},
				signature,
			),
		).toBe(true);
	});

	it.each([
		["wrong repository", { GITHUB_REPOSITORY: "attacker/lobu" }],
		["wrong ref", { GITHUB_REF: "refs/heads/feature" }],
		[
			"wrong full workflow ref",
			{
				GITHUB_WORKFLOW_REF:
					"shifu-ai/lobu/.github/workflows/other.yml@refs/heads/main",
			},
		],
		["wrong event", { GITHUB_EVENT_NAME: "push" }],
		["wrong mode", { EXPORT_MODE: "build" }],
		["invalid key id", { RECEIPT_KEY_ID: "invalid key id" }],
		["missing key id", { RECEIPT_KEY_ID: undefined }],
		["missing private key", { RECEIPT_PRIVATE_KEY_PKCS8: undefined }],
	])("fails closed for %s without an artifact or secret output", (_label, overrides) => {
		const privateKeyPkcs8Base64 = testEd25519PrivateKey();
		const result = runExporter({ privateKeyPkcs8Base64, overrides });
		expect(result.status).not.toBe(0);
		expect(() => readFileSync(result.artifactPath)).toThrow();
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			privateKeyPkcs8Base64,
		);
	});

	it("rejects a non-Ed25519 private key without an artifact or private-key output", () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const privateKeyPkcs8Base64 = privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64");
		const result = runExporter({ privateKeyPkcs8Base64 });
		expect(result.status).not.toBe(0);
		expect(() => readFileSync(result.artifactPath)).toThrow();
		expect(`${result.stdout}\n${result.stderr}`).not.toContain(
			privateKeyPkcs8Base64,
		);
	});

	it("keeps signing secrets confined to the protected export step and uploads one fixed artifact", () => {
		const exporter = job("export-lobu-build-public-key");
		const protectedStep = step(
			exporter,
			"Export protected Lobu build receipt public key",
		);
		expect(protectedStep).toContain(
			`RECEIPT_PRIVATE_KEY_PKCS8: \${{ secrets.AGENT_RELEASE_LOBU_BUILD_RECEIPT_PRIVATE_KEY_PKCS8 }}`,
		);
		expect(protectedStep).toContain(
			`RECEIPT_KEY_ID: \${{ secrets.AGENT_RELEASE_LOBU_BUILD_RECEIPT_KEY_ID }}`,
		);
		expect(
			exporter.match(/AGENT_RELEASE_LOBU_BUILD_RECEIPT_PRIVATE_KEY_PKCS8/g),
		).toHaveLength(1);
		expect(
			exporter.match(/AGENT_RELEASE_LOBU_BUILD_RECEIPT_KEY_ID/g),
		).toHaveLength(1);
		expect(protectedStep).not.toMatch(/\bsign\s*\(/);

		const script = exporterScript();
		const keyImportOffset = script.indexOf("createPrivateKey({");
		expect(keyImportOffset).toBeGreaterThan(0);
		for (const check of [
			"repository !== 'shifu-ai/lobu'",
			"!allowedRefs.has(ref)",
			"GITHUB_WORKFLOW_REF !== expectedWorkflowRef",
			"GITHUB_EVENT_NAME !== 'workflow_dispatch'",
			"EXPORT_MODE !== 'export_build_public_key'",
		]) {
			expect(script.indexOf(check), check).toBeGreaterThanOrEqual(0);
			expect(script.indexOf(check), check).toBeLessThan(keyImportOffset);
		}

		const uploadStep = step(exporter, "Upload Lobu build receipt public key");
		expect(uploadStep).toContain(
			"uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
		);
		expect(uploadStep).toContain("path: lobu-build-public-key.json");
		expect(uploadStep).toContain("retention-days: 90");
		expect(uploadStep.match(/^\s+path:/gm)).toHaveLength(1);
	});
});

function job(name: string): string {
	const match = workflow.match(
		new RegExp(
			`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:\\n|(?![\\s\\S]))`,
			"m",
		),
	);
	if (!match) throw new Error(`workflow job not found: ${name}`);
	return match[0];
}

function step(jobText: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = jobText.match(
		new RegExp(
			`^      - name: ${escaped}\\n([\\s\\S]*?)(?=^      - (?:name:|uses:)|(?![\\s\\S]))`,
			"m",
		),
	);
	if (!match) throw new Error(`workflow step not found: ${name}`);
	return match[0];
}

type WorkflowContext = {
	github: { repository: string; event_name: string; ref: string };
	inputs: { mode?: string };
	failed: boolean;
};

function workflowContext({
	eventName = "workflow_dispatch",
	mode,
	ref = "refs/heads/codex/build-receipt-public-key",
	failed = false,
}: {
	eventName?: string;
	mode?: string;
	ref?: string;
	failed?: boolean;
}): WorkflowContext {
	return {
		github: { repository: "shifu-ai/lobu", event_name: eventName, ref },
		inputs: mode ? { mode } : {},
		failed,
	};
}

function plannedJobs(context: WorkflowContext): string[] {
	const jobsText = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1];
	if (!jobsText) throw new Error("workflow jobs not found");
	const names = [...jobsText.matchAll(/^ {2}([a-z][a-z0-9-]+):$/gm)].map(
		(match) => match[1],
	);
	const planned = new Map<string, boolean>();
	const isPlanned = (name: string): boolean => {
		const known = planned.get(name);
		if (known !== undefined) return known;
		const expression = job(name).match(/^ {4}if: (.+)$/m)?.[1];
		if (!expression) throw new Error(`job guard not found: ${name}`);
		const unwrapped = expression
			.replace(/^\$\{\{\s*/, "")
			.replace(/\s*\}\}$/, "");
		const guardAllows = Boolean(
			runInNewContext(unwrapped, {
				github: context.github,
				inputs: context.inputs,
				failure: () => context.failed,
			}),
		);
		const dependenciesAllow = jobNeeds(name).every(isPlanned);
		const hasStatusFunction = /\b(?:always|cancelled|failure|success)\(\)/.test(
			unwrapped,
		);
		const result = guardAllows && (hasStatusFunction || dependenciesAllow);
		planned.set(name, result);
		return result;
	};
	return names.filter(isPlanned);
}

function jobNeeds(name: string): string[] {
	const jobText = job(name);
	const inline = jobText.match(/^ {4}needs: \[([^\]]+)\]$/m)?.[1];
	if (inline) return inline.split(",").map((dependency) => dependency.trim());
	const multiline = jobText.match(
		/^ {4}needs:\n([\s\S]*?)(?=^ {4}[a-z])/m,
	)?.[1];
	if (!multiline) return [];
	return [...multiline.matchAll(/^\s+([a-z][a-z0-9-]+),?$/gm)].map(
		(match) => match[1],
	);
}

function exporterScript(): string {
	const exportStep = step(
		job("export-lobu-build-public-key"),
		"Export protected Lobu build receipt public key",
	);
	const match = exportStep.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/);
	if (!match) throw new Error("inline public-key exporter not found");
	return match[1].replace(/^ {10}/gm, "");
}

function runExporter({
	privateKeyPkcs8Base64,
	overrides = {},
}: {
	privateKeyPkcs8Base64: string;
	overrides?: Record<string, string | undefined>;
}) {
	const directory = mkdtempSync(join(tmpdir(), "lobu-public-key-export-"));
	directories.push(directory);
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		GITHUB_REPOSITORY: "shifu-ai/lobu",
		GITHUB_REF: "refs/heads/codex/build-receipt-public-key",
		GITHUB_WORKFLOW_REF:
			"shifu-ai/lobu/.github/workflows/build-images.yml@refs/heads/codex/build-receipt-public-key",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		EXPORT_MODE: "export_build_public_key",
		RECEIPT_KEY_ID: "lobu-build-receipt-2026-01",
		RECEIPT_PRIVATE_KEY_PKCS8: privateKeyPkcs8Base64,
		...overrides,
	};
	for (const key of Object.keys(env)) {
		if (env[key] === undefined) delete env[key];
	}
	const result = spawnSync("node", ["-e", exporterScript()], {
		cwd: directory,
		env: env as NodeJS.ProcessEnv,
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		artifactPath: join(directory, "lobu-build-public-key.json"),
	};
}

function testEd25519PrivateKey(): string {
	const { privateKey } = generateKeyPairSync("ed25519");
	return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([left], [right]) =>
						left.localeCompare(right),
					),
				)
			: item,
	);
}
