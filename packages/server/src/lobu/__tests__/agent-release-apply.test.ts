import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	sign as signBytes,
	verify as verifySignature,
} from "node:crypto";
import { Hono } from "hono";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { orgContext } from "../stores/org-context.js";

const ORG_ID = "org-agent-release";
const OTHER_ORG_ID = "org-agent-release-other";
const AGENT_ID = "shifu-u-irene";
const KEY_ID = "agent-release-test-2026";
const EVIDENCE_KEY_ID = "lobu-runtime-evidence-2026";
const MAX_RELEASE_BODY_BYTES = 1024 * 1024;
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIIPVIttIdPiKTq8G2u58MHvf7DqR4wTOzHGSogMA6bou
-----END PRIVATE KEY-----`;
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQWoeOZo6E/cNothD0UhqzcXDgWm7UqAAOLqmShGzLdw=
-----END PUBLIC KEY-----`;

type ManagedSettings = {
	identityMd?: string;
	soulMd?: string;
	userMd?: string;
	modelSelection?: { mode: "auto" } | { mode: "pinned"; pinnedModel: string };
	toolsConfig?: {
		allowedTools?: string[];
		deniedTools?: string[];
		strictMode?: boolean;
		mcpExposure?: "tools" | "cli";
	};
};

type PublicationKind = "release" | "rollback";

interface ReleaseFixtureOptions {
	releaseSequence?: number;
	feedSequence?: number;
	releaseId?: string;
	managedSettings?: ManagedSettings | Record<string, unknown>;
	environment?: "local" | "staging" | "production";
	publicationKind?: PublicationKind;
	fromReleaseSequence?: number;
	toReleaseSequence?: number;
	toReleaseId?: string;
	allowDowngrade?: boolean;
	rollbackReason?: string;
	rollbackActor?: string;
	rollbackExpiresAt?: string;
	manifestRollbackToSequence?: number;
	manifestRollbackTo?: string;
	omitManifestRollbackTo?: boolean;
	omitManifestRollbackToSequence?: boolean;
	expectedCurrentReleaseSequence?: number | null;
	agentId?: string;
	keyId?: string;
	channel?: "candidate" | "stable";
	createdAt?: string;
	generatedAt?: string;
}

beforeAll(async () => {
	await ensureDbForGatewayTests();
});

beforeEach(async () => {
	await resetTestDatabase();
	await seedOrg(ORG_ID);
	await seedOrg(OTHER_ORG_ID);
	await seedAgent();
});

describe("signed managed agent release apply", () => {
	test("rejects legacy broad provisioning after a managed release is applied", async () => {
		const app = await buildApp();
		const release = await putApply(app, latestSignedApplyRequest());
		expect(release.status).toBe(200);

		const legacy = await app.request("/api/provisioning/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: AGENT_ID,
				name: "Irene Agent",
				ownerUserId: "irene",
				settings: { userMd: "stale onboarding prompt" },
			}),
		});

		expect(legacy.status).toBe(409);
		await expect(legacy.json()).resolves.toEqual({
			error: "agent_settings_managed_by_release",
			error_description:
				"Agent release-owned settings must be changed through managed release apply",
		});
		const rows = await (await db())`
			SELECT user_md
			FROM agents
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;
		expect(rows[0]?.user_md).toBe("release user");
	});

	test("serializes legacy provisioning against managed release apply without post-release overwrite", async () => {
		const app = await buildApp();
		const [release, legacy] = await Promise.all([
			putApply(app, latestSignedApplyRequest()),
			app.request("/api/provisioning/agents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentId: AGENT_ID,
					name: "Irene Agent",
					ownerUserId: "irene",
					settings: { userMd: "racing stale onboarding prompt" },
				}),
			}),
		]);

		expect(release.status).toBe(200);
		expect([200, 409]).toContain(legacy.status);
		const rows = await (await db())`
			SELECT user_md
			FROM agents
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;
		expect(rows[0]?.user_md).toBe("release user");
	});

	test("accepts the current Toolbox policy envelope and returns attempt-bound signed post-apply evidence", async () => {
		const app = await buildApp();
		const request = latestSignedApplyRequest();

		const response = await putApply(app, request);
		expect(response.status).toBe(200);
		const evidence = await response.json();
		expect(evidence).toEqual({
			evidenceKind: "post_apply",
			environment: "production",
			targetId: request.assignment.targetId,
			agentId: AGENT_ID,
			assignmentRevision: request.assignmentRevision,
			claimToken: request.claimToken,
			stepOrdinal: request.stepOrdinal,
			stepLeaseToken: request.stepLeaseToken,
			releaseId: request.signedManifest.releaseId,
			releaseSequence: request.signedManifest.releaseSequence,
			feedSequence: request.signedFeed.feedSequence,
			feedDigest: digestValue(request.signedFeed),
			manifestDigest: digestValue(request.signedManifest),
			revisionRef: expect.stringMatching(
				/^lobu:shifu-u-irene:agent-release:1:/,
			),
			settingsHash:
				request.signedManifest.controlPlanePolicy.baseline.settingsHash,
			drifted: false,
			postApplySmoke: {
				passed: true,
				digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			},
			observedAt: expect.any(String),
			expiresAt: expect.any(String),
			evidenceRef: expect.stringMatching(/^lobu:managed-settings:/),
			evidenceSigning: {
				algorithm: "Ed25519",
				keyId: EVIDENCE_KEY_ID,
				signature: expect.any(String),
			},
		});
		const { signature, ...evidenceSigning } = evidence.evidenceSigning;
		expect(
			verifySignature(
				null,
				Buffer.from(
					canonicalizeForTest({
						...withoutKey(evidence, "evidenceSigning"),
						evidenceSigning,
					}),
				),
				createPublicKey(PUBLIC_KEY),
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
	});

	test("binds the Toolbox apply attempt fields into the command digest", async () => {
		const app = await buildApp();
		const request = latestSignedApplyRequest();
		request.stepOrdinal += 1;

		const response = await putApply(app, request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_command_digest_mismatch",
		});
	});

	test.each([
		["missing", ""],
		[
			"active key mismatch",
			JSON.stringify({
				activeKeyId: "missing",
				keys: {
					[EVIDENCE_KEY_ID]: evidencePrivateKeyDer(),
				},
			}),
		],
		[
			"invalid PKCS8",
			JSON.stringify({
				activeKeyId: EVIDENCE_KEY_ID,
				keys: {
					[EVIDENCE_KEY_ID]: Buffer.from("not-pkcs8").toString("base64"),
				},
			}),
		],
	])("fails closed before mutation when the evidence signer is %s", async (_label, signerJson) => {
		const app = await buildApp({ evidenceSigningPrivateKeysJson: signerJson });
		const response = await putApply(app, latestSignedApplyRequest());
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "agent_release_evidence_signer_unavailable",
			error_description: "Agent release runtime evidence signer is unavailable",
		});
		expect(await currentIdentity()).toBe("existing identity");
	});

	test("uses only the configured active evidence key during rotation", async () => {
		const rotatedKeyId = "lobu-runtime-evidence-2026-b";
		const app = await buildApp({
			evidenceSigningPrivateKeysJson: JSON.stringify({
				activeKeyId: rotatedKeyId,
				keys: {
					[EVIDENCE_KEY_ID]: evidencePrivateKeyDer(),
					[rotatedKeyId]: evidencePrivateKeyDer(),
				},
			}),
		});
		const response = await putApply(app, latestSignedApplyRequest());
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			evidenceSigning: { keyId: rotatedKeyId },
		});
	});

	test("repairs same-sequence drift under a fresh Toolbox attempt and signs the repaired read-back", async () => {
		const app = await buildApp();
		const first = latestSignedApplyRequest();
		expect((await putApply(app, first)).status).toBe(200);
		const sql = await db();
		await sql`
			UPDATE agents
			SET tools_config = ${sql.json({ allowedTools: ["drifted_tool"] })}
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;

		const repair = latestSignedApplyRequest();
		repair.expectedCurrentReleaseSequence = 1;
		repair.claimToken = "55555555-5555-4555-8555-555555555555";
		repair.stepLeaseToken = "66666666-6666-4666-8666-666666666666";
		repair.commandDigest = commandDigest(repair);
		const response = await putApply(app, repair);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			claimToken: repair.claimToken,
			stepLeaseToken: repair.stepLeaseToken,
			settingsHash:
				repair.signedManifest.controlPlanePolicy.baseline.settingsHash,
			drifted: false,
			postApplySmoke: { passed: true },
		});
	});

	test("returns fresh exact attempt evidence for an idempotent same-sequence no-drift retry", async () => {
		const app = await buildApp();
		const first = latestSignedApplyRequest();
		expect((await putApply(app, first)).status).toBe(200);
		const retry = latestSignedApplyRequest();
		retry.expectedCurrentReleaseSequence = 1;
		retry.claimToken = "77777777-7777-4777-8777-777777777777";
		retry.stepLeaseToken = "88888888-8888-4888-8888-888888888888";
		retry.commandDigest = commandDigest(retry);
		const response = await putApply(app, retry);
		expect(response.status).toBe(200);
		const evidence = await response.json();
		expect(evidence.claimToken).toBe(retry.claimToken);
		expect(evidence.stepLeaseToken).toBe(retry.stepLeaseToken);
		expect(Object.keys(evidence).sort()).toEqual(
			[
				"agentId",
				"assignmentRevision",
				"claimToken",
				"drifted",
				"environment",
				"evidenceKind",
				"evidenceRef",
				"evidenceSigning",
				"expiresAt",
				"feedDigest",
				"feedSequence",
				"manifestDigest",
				"observedAt",
				"postApplySmoke",
				"releaseId",
				"releaseSequence",
				"revisionRef",
				"settingsHash",
				"stepLeaseToken",
				"stepOrdinal",
				"targetId",
			].sort(),
		);
	});

	test("enforces expected-current CAS on current-contract same-sequence retries", async () => {
		const app = await buildApp();
		const first = latestSignedApplyRequest();
		expect((await putApply(app, first)).status).toBe(200);
		const stale = latestSignedApplyRequest();
		const response = await putApply(app, stale);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_expected_current_mismatch",
		});

		const wrong = latestSignedApplyRequest();
		wrong.expectedCurrentReleaseSequence = 2;
		wrong.commandDigest = commandDigest(wrong);
		expect((await putApply(app, wrong)).status).toBe(409);

		const tampered = latestSignedApplyRequest();
		tampered.expectedCurrentReleaseSequence = 1;
		const tamperedResponse = await putApply(app, tampered);
		expect(tamperedResponse.status).toBe(400);
		await expect(tamperedResponse.json()).resolves.toMatchObject({
			error: "agent_release_command_digest_mismatch",
		});
	});

	test.each([
		[
			"runtime carrier with shared activation",
			"runtime_carrier",
			"shared_carrier",
		],
		[
			"runtime carrier with per-agent activation",
			"runtime_carrier",
			"per_agent",
		],
		[
			"capability release with shared activation",
			"capability_activation",
			"shared_carrier",
		],
	] as const)("rejects %s at the managed-settings boundary", async (_label, releaseKind, activationMode) => {
		const app = await buildApp();
		const request = latestSignedApplyRequest();
		request.signedManifest.releaseKind = releaseKind;
		request.signedFeed.activationMode = activationMode;
		if (releaseKind === "runtime_carrier") {
			(
				request.signedManifest.controlPlanePolicy as Record<string, unknown>
			).runtimeCarrier = testRuntimeCarrierPolicy();
		}
		resignLatestRequest(request);
		const response = await putApply(app, request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_invalid_request",
			error_description:
				"Managed settings only accept per-agent capability activation releases",
		});
		expect(await currentIdentity()).toBe("existing identity");
	});

	test("rejects a tampered activation mode before managed-settings compatibility checks", async () => {
		const app = await buildApp();
		const request = latestSignedApplyRequest();
		request.signedFeed.activationMode = "shared_carrier";
		request.commandDigest = commandDigest(request);
		const response = await putApply(app, request);
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_feed_signature_invalid",
		});
		expect(await currentIdentity()).toBe("existing identity");
	});

	test("atomically applies only managed columns and exposes bounded evidence", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({
			managedSettings: {
				identityMd: "release identity",
				soulMd: "release soul",
				userMd: "release user",
				modelSelection: { mode: "pinned", pinnedModel: "openai/gpt-5" },
				toolsConfig: {
					allowedTools: ["manage_schedules"],
					deniedTools: ["dangerous_tool"],
					strictMode: true,
					mcpExposure: "tools",
				},
			},
		});

		const response = await putApply(app, request);
		expect(response.status).toBe(200);
		const applied = await response.json();
		expect(applied).toMatchObject({
			ok: true,
			agentId: AGENT_ID,
			releaseSequence: 1,
			feedSequence: 1,
			status: "applied",
			idempotent: false,
			channel: "candidate",
		});
		expect(applied.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(applied.feedDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(applied.settingsHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(applied.revisionRef).toMatch(/^lobu:shifu-u-irene:agent-release:1:/);

		const sql = await db();
		const rows = await sql`
			SELECT identity_md, soul_md, user_md, model_selection, tools_config,
			       network_config, mcp_servers, skills_config, pre_approved_tools,
			       guardrails, provider_model_preferences
			FROM agents
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;
		expect(rows[0]).toEqual({
			identity_md: "release identity",
			soul_md: "release soul",
			user_md: "release user",
			model_selection: { mode: "pinned", pinnedModel: "openai/gpt-5" },
			tools_config: {
				allowedTools: ["manage_schedules"],
				deniedTools: ["dangerous_tool"],
				strictMode: true,
				mcpExposure: "tools",
			},
			network_config: { allowedDomains: ["existing.example"] },
			mcp_servers: {
				existing: { type: "streamable-http", url: "https://mcp.example" },
			},
			skills_config: { skills: [{ name: "existing" }] },
			pre_approved_tools: ["existing_tool"],
			guardrails: ["existing_guardrail"],
			provider_model_preferences: { openai: "openai/existing" },
		});

		const evidenceResponse = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		expect(evidenceResponse.status).toBe(200);
		const evidence = await evidenceResponse.json();
		expect(evidence).toEqual({
			ok: true,
			agentId: AGENT_ID,
			releaseId: "agent-2026.07.13.1",
			releaseSequence: 1,
			feedSequence: 1,
			channel: "candidate",
			feedDigest: applied.feedDigest,
			manifestDigest: applied.manifestDigest,
			status: "applied",
			revisionRef: applied.revisionRef,
			settingsHash: applied.settingsHash,
			appliedAt: expect.any(String),
		});
		expect(JSON.stringify(evidence)).not.toContain("release identity");
		expect(evidence).not.toHaveProperty("settings");
	});

	test("reports live managed-settings drift and repairs it on the same signed retry", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({
			managedSettings: {
				identityMd: "managed identity",
				toolsConfig: {
					allowedTools: ["manage_schedules"],
					strictMode: true,
				},
			},
		});
		const appliedResponse = await putApply(app, request);
		const applied = await appliedResponse.json();
		expect(appliedResponse.status).toBe(200);

		const sql = await db();
		await sql`
			UPDATE agents
			SET tools_config = ${sql.json({ allowedTools: ["drifted_tool"] })}
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;
		const driftResponse = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		expect(driftResponse.status).toBe(200);
		const drift = await driftResponse.json();
		expect(drift).toMatchObject({
			status: "drifted",
			settingsHash: applied.settingsHash,
			liveSettingsHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
		});
		expect(drift.liveSettingsHash).not.toBe(applied.settingsHash);
		expect(drift).not.toHaveProperty("settings");
		expect(JSON.stringify(drift)).not.toContain("drifted_tool");

		const repairResponse = await putApply(app, request);
		expect(repairResponse.status).toBe(200);
		await expect(repairResponse.json()).resolves.toMatchObject({
			status: "applied",
			idempotent: false,
			repaired: true,
			settingsHash: applied.settingsHash,
		});
		const repairedEvidence = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		expect(repairedEvidence.status).toBe(200);
		await expect(repairedEvidence.json()).resolves.toMatchObject({
			status: "applied",
			settingsHash: applied.settingsHash,
		});
	});

	test("rolls back a partial repair when drift remains in an omitted managed field", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({
			managedSettings: { identityMd: "signed identity" },
		});
		const appliedResponse = await putApply(app, request);
		const applied = await appliedResponse.json();
		expect(appliedResponse.status).toBe(200);

		const sql = await db();
		await sql`
			UPDATE agents SET
				identity_md = 'external identity drift',
				tools_config = ${sql.json({ allowedTools: ["omitted_drift"] })}
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;
		const retryResponse = await putApply(app, request);
		expect(retryResponse.status).toBe(409);
		await expect(retryResponse.json()).resolves.toMatchObject({
			error: "agent_release_settings_drift_unrepairable",
		});

		const rows = await sql<{
			identity_md: string;
			settings_hash: string;
		}>`
			SELECT a.identity_md, r.settings_hash
			FROM agents a
			JOIN agent_release_applies r
			  ON r.organization_id = a.organization_id AND r.agent_id = a.id
			WHERE a.organization_id = ${ORG_ID} AND a.id = ${AGENT_ID}
		`;
		expect(rows[0]).toEqual({
			identity_md: "external identity drift",
			settings_hash: applied.settingsHash,
		});
		const evidenceResponse = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		expect(evidenceResponse.status).toBe(200);
		await expect(evidenceResponse.json()).resolves.toMatchObject({
			status: "drifted",
			settingsHash: applied.settingsHash,
			liveSettingsHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
		});
	});

	test("repairs a partial manifest when all drift is in its present identity field", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({
			managedSettings: { identityMd: "signed identity" },
		});
		const appliedResponse = await putApply(app, request);
		const applied = await appliedResponse.json();
		expect(appliedResponse.status).toBe(200);
		await (await db())`
			UPDATE agents SET identity_md = 'identity drift'
			WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
		`;

		const retryResponse = await putApply(app, request);
		expect(retryResponse.status).toBe(200);
		await expect(retryResponse.json()).resolves.toMatchObject({
			status: "applied",
			idempotent: false,
			repaired: true,
			settingsHash: applied.settingsHash,
		});
		await expect(currentIdentity()).resolves.toBe("signed identity");
		const evidenceResponse = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		await expect(evidenceResponse.json()).resolves.toMatchObject({
			status: "applied",
			settingsHash: applied.settingsHash,
		});
	});

	test("rejects declared and chunked release bodies above one MiB before parsing", async () => {
		const app = await buildApp();
		const path = `/api/provisioning/agents/${AGENT_ID}/managed-settings`;
		const declared = await app.request(path, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"content-length": String(MAX_RELEASE_BODY_BYTES + 1),
			},
			body: "{}",
		});
		expect(declared.status).toBe(413);

		const chunk = new Uint8Array(600 * 1024).fill(0x20);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.enqueue(chunk);
				controller.close();
			},
		});
		const chunkedRequest = new Request(`http://localhost${path}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: stream,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect((await app.request(chunkedRequest)).status).toBe(413);
		expect((await putApply(app, signedApplyRequest({}))).status).toBe(200);
	});

	test("requires signed timestamps to be strict valid RFC3339 values", async () => {
		const app = await buildApp();
		for (const request of [
			signedApplyRequest({ createdAt: "July 13, 2026 13:00" }),
			signedApplyRequest({ createdAt: "2026-02-30T13:00:00Z" }),
			signedApplyRequest({ generatedAt: "2026-07-13T13:01:00" }),
			signedApplyRequest({
				publicationKind: "rollback",
				rollbackExpiresAt: "2099-07-13 13:02:00Z",
			}),
		]) {
			const response = await putApply(app, request);
			expect(response.status).toBe(400);
		}
		const offsetTimestamp = signedApplyRequest({
			createdAt: "2026-07-13T21:00:00+08:00",
			generatedAt: "2026-07-13T21:01:00+08:00",
		});
		expect((await putApply(app, offsetTimestamp)).status).toBe(200);
	});

	test("rejects duplicate keyring members while allowing bounded key rotation", async () => {
		const encoded = JSON.parse(trustedPublicKeysJson())[KEY_ID] as string;
		for (const trustedPublicKeysJson of [
			`{"${KEY_ID}":${JSON.stringify(encoded)},"${KEY_ID}":${JSON.stringify(encoded)}}`,
			`{"${KEY_ID}":${JSON.stringify(encoded)},"agent\\u002drelease-test-2026":${JSON.stringify(encoded)}}`,
			JSON.stringify({ ["k".repeat(70 * 1024)]: encoded }),
		]) {
			const response = await putApply(
				await buildApp({ trustedPublicKeysJson }),
				signedApplyRequest({}),
			);
			expect(response.status).toBe(503);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_keyring_unavailable",
			});
		}

		const rotatedKeyId = "agent-release-test-2026-b";
		const rotatedApp = await buildApp({
			trustedPublicKeysJson: JSON.stringify({
				[KEY_ID]: encoded,
				[rotatedKeyId]: encoded,
			}),
		});
		expect(
			(await putApply(rotatedApp, signedApplyRequest({ keyId: rotatedKeyId })))
				.status,
		).toBe(200);
	});

	test("rejects a tampered manifest before mutating the agent", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({});
		request.signedManifest.managedSettings.identityMd = "tampered";
		request.commandDigest = commandDigest(request);

		const response = await putApply(app, request);
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_manifest_signature_invalid",
		});
		await expect(currentIdentity()).resolves.toBe("existing identity");
	});

	test("fails closed for an unknown key or an unavailable keyring", async () => {
		const unknownKey = signedApplyRequest({ keyId: "unknown-key" });
		const unknownResponse = await putApply(await buildApp(), unknownKey);
		expect(unknownResponse.status).toBe(403);
		await expect(unknownResponse.json()).resolves.toMatchObject({
			error: "agent_release_signing_key_unknown",
		});

		const unavailableResponse = await putApply(
			await buildApp({ trustedPublicKeysJson: "" }),
			signedApplyRequest({}),
		);
		expect(unavailableResponse.status).toBe(503);
		await expect(unavailableResponse.json()).resolves.toMatchObject({
			error: "agent_release_keyring_unavailable",
		});
		await expect(currentIdentity()).resolves.toBe("existing identity");
	});

	test("rejects wrong organization and assignment scope", async () => {
		const otherOrgApp = await buildApp({ organizationId: OTHER_ORG_ID });
		const wrongOrg = await putApply(otherOrgApp, signedApplyRequest({}));
		expect(wrongOrg.status).toBe(404);
		await expect(wrongOrg.json()).resolves.toMatchObject({
			error: "agent_release_agent_not_found",
		});

		const wrongEnvironment = signedApplyRequest({});
		wrongEnvironment.assignment.environment = "staging";
		wrongEnvironment.commandDigest = commandDigest(wrongEnvironment);
		const wrongEnvironmentResponse = await putApply(
			await buildApp(),
			wrongEnvironment,
		);
		expect(wrongEnvironmentResponse.status).toBe(400);
		await expect(wrongEnvironmentResponse.json()).resolves.toMatchObject({
			error: "agent_release_environment_mismatch",
		});
	});

	test("fails closed when runtime environment is missing, invalid, or mismatched", async () => {
		for (const agentReleaseEnvironment of ["", "qa"]) {
			const response = await putApply(
				await buildApp({ agentReleaseEnvironment }),
				signedApplyRequest({}),
			);
			expect(response.status).toBe(503);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_environment_unavailable",
			});
		}

		const mismatch = await putApply(
			await buildApp({ agentReleaseEnvironment: "production" }),
			signedApplyRequest({ environment: "staging" }),
		);
		expect(mismatch.status).toBe(400);
		await expect(mismatch.json()).resolves.toMatchObject({
			error: "agent_release_environment_mismatch",
		});
	});

	test("does not overwrite an existing receipt from another runtime environment", async () => {
		const app = await buildApp();
		expect((await putApply(app, signedApplyRequest({}))).status).toBe(200);
		const sql = await db();
		await sql`
			UPDATE agent_release_applies
			SET environment = 'staging'
			WHERE organization_id = ${ORG_ID} AND agent_id = ${AGENT_ID}
		`;

		const response = await putApply(
			app,
			signedApplyRequest({
				releaseId: "agent-environment-2",
				releaseSequence: 2,
				feedSequence: 2,
				expectedCurrentReleaseSequence: 1,
			}),
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_receipt_environment_mismatch",
		});
		const receipt = await sql`
			SELECT environment, applied_release_sequence
			FROM agent_release_applies
			WHERE organization_id = ${ORG_ID} AND agent_id = ${AGENT_ID}
		`;
		expect(receipt[0]).toEqual({
			environment: "staging",
			applied_release_sequence: 1,
		});
	});

	test("rejects unmanaged and unknown nested settings without silently dropping them", async () => {
		const app = await buildApp();
		for (const managedSettings of [
			{ baselinePrompt: "not a Lobu setting" },
			{ runtimeConfig: { carrier: "new" } },
			{ modelSelection: { mode: "auto", pinnedModel: "must-not-exist" } },
			{ toolsConfig: { strictMode: true, unknown: true } },
		]) {
			const response = await putApply(
				app,
				signedApplyRequest({ managedSettings }),
			);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_invalid_managed_settings",
			});
		}
		await expect(currentIdentity()).resolves.toBe("existing identity");
	});

	test("rejects non-I-JSON values including lone UTF-16 surrogates", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({
			managedSettings: { identityMd: "valid" },
		});
		request.signedManifest.managedSettings.identityMd = "\uD800";
		const response = await putApply(app, request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_invalid_json",
		});
	});

	test("rejects publication identity, digest, assignment agent, and command digest mismatches", async () => {
		const app = await buildApp();

		const identityMismatch = signedApplyRequest({});
		identityMismatch.signedFeed.publications[0].releaseId = "different-release";
		resignFeed(identityMismatch.signedFeed);
		identityMismatch.commandDigest = commandDigest(identityMismatch);
		let response = await putApply(app, identityMismatch);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_publication_identity_mismatch",
		});

		const digestMismatch = signedApplyRequest({});
		digestMismatch.signedFeed.publications[0].manifestDigest = `sha256:${"0".repeat(64)}`;
		resignFeed(digestMismatch.signedFeed);
		digestMismatch.commandDigest = commandDigest(digestMismatch);
		response = await putApply(app, digestMismatch);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_publication_digest_mismatch",
		});

		const assignmentMismatch = signedApplyRequest({});
		assignmentMismatch.assignment.agentId = "shifu-u-someone-else";
		assignmentMismatch.commandDigest = commandDigest(assignmentMismatch);
		response = await putApply(app, assignmentMismatch);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_assignment_scope_mismatch",
		});

		const badCommandDigest = signedApplyRequest({});
		badCommandDigest.commandDigest = `sha256:${"f".repeat(64)}`;
		response = await putApply(app, badCommandDigest);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_command_digest_mismatch",
		});
	});

	test("treats an identical same-sequence retry as idempotent", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({});
		const first = await putApply(app, request);
		expect(first.status).toBe(200);
		const firstBody = await first.json();

		const retry = await putApply(app, request);
		expect(retry.status).toBe(200);
		const retryBody = await retry.json();
		expect(retryBody).toEqual({ ...firstBody, idempotent: true });

		const receipts = await (await db())`
			SELECT COUNT(*)::int AS count
			FROM agent_release_applies
			WHERE organization_id = ${ORG_ID} AND agent_id = ${AGENT_ID}
		`;
		expect(receipts[0].count).toBe(1);
	});

	test("advances feed evidence for the same manifest so older publications cannot replay", async () => {
		const app = await buildApp();
		expect((await putApply(app, signedApplyRequest({}))).status).toBe(200);

		const republished = signedApplyRequest({
			feedSequence: 2,
			expectedCurrentReleaseSequence: 1,
		});
		const response = await putApply(app, republished);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			releaseSequence: 1,
			feedSequence: 2,
			idempotent: true,
		});

		const replay = signedApplyRequest({
			releaseSequence: 2,
			feedSequence: 1,
			releaseId: "agent-feed-replay",
			expectedCurrentReleaseSequence: 1,
		});
		const replayResponse = await putApply(app, replay);
		expect(replayResponse.status).toBe(409);
		await expect(replayResponse.json()).resolves.toMatchObject({
			error: "agent_release_feed_replay",
		});
	});

	test("rejects reuse of a channel feed sequence with different signed bytes", async () => {
		const app = await buildApp();
		expect((await putApply(app, signedApplyRequest({}))).status).toBe(200);

		const changedFeedBytes = signedApplyRequest({
			generatedAt: "2026-07-13T13:09:00.000Z",
			expectedCurrentReleaseSequence: 1,
		});
		const response = await putApply(app, changedFeedBytes);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_feed_sequence_conflict",
		});
	});

	test("tracks candidate and stable feed sequences independently", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						feedSequence: 2,
						channel: "candidate",
					}),
				)
			).status,
		).toBe(200);

		const stable = await putApply(
			app,
			signedApplyRequest({
				releaseSequence: 2,
				releaseId: "agent-stable-2",
				feedSequence: 1,
				channel: "stable",
				expectedCurrentReleaseSequence: 1,
				managedSettings: { identityMd: "stable channel" },
			}),
		);
		expect(stable.status).toBe(200);
		await expect(stable.json()).resolves.toMatchObject({
			releaseSequence: 2,
			feedSequence: 1,
			channel: "stable",
		});

		const cursors = await (await db())`
			SELECT channel, highest_feed_sequence
			FROM agent_release_feed_cursors
			WHERE organization_id = ${ORG_ID} AND agent_id = ${AGENT_ID}
			ORDER BY channel
		`;
		expect(cursors).toEqual([
			{ channel: "candidate", highest_feed_sequence: 2 },
			{ channel: "stable", highest_feed_sequence: 1 },
		]);
	});

	test("conflicts when a sequence is reused with another digest", async () => {
		const app = await buildApp();
		expect((await putApply(app, signedApplyRequest({}))).status).toBe(200);

		const reused = signedApplyRequest({
			releaseSequence: 1,
			feedSequence: 2,
			releaseId: "agent-2026.07.13.reused",
			managedSettings: { identityMd: "different payload" },
			expectedCurrentReleaseSequence: 1,
		});
		const response = await putApply(app, reused);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_sequence_conflict",
		});
		await expect(currentIdentity()).resolves.toBe("release identity");
	});

	test("rejects stale ordinary apply and expected-current CAS mismatch", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 2,
						feedSequence: 2,
						releaseId: "agent-2026.07.13.2",
						managedSettings: { identityMd: "sequence two" },
					}),
				)
			).status,
		).toBe(200);

		let response = await putApply(
			app,
			signedApplyRequest({
				releaseSequence: 1,
				feedSequence: 3,
				releaseId: "agent-2026.07.13.1",
				managedSettings: { identityMd: "stale ordinary" },
				expectedCurrentReleaseSequence: 2,
			}),
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_stale",
		});

		response = await putApply(
			app,
			signedApplyRequest({
				releaseSequence: 3,
				feedSequence: 4,
				releaseId: "agent-2026.07.13.3",
				managedSettings: { identityMd: "bad expected current" },
				expectedCurrentReleaseSequence: 1,
			}),
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_expected_current_mismatch",
		});
		await expect(currentIdentity()).resolves.toBe("sequence two");
	});

	test("allows a lower release sequence only through an explicit newer signed rollback publication", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 2,
						feedSequence: 2,
						releaseId: "agent-2026.07.13.2",
						managedSettings: { identityMd: "sequence two" },
						manifestRollbackTo: "agent-2026.07.13.1",
						manifestRollbackToSequence: 1,
					}),
				)
			).status,
		).toBe(200);

		const rollback = signedApplyRequest({
			releaseSequence: 1,
			feedSequence: 3,
			releaseId: "agent-2026.07.13.1",
			managedSettings: { identityMd: "signed rollback" },
			publicationKind: "rollback",
			fromReleaseSequence: 2,
			toReleaseSequence: 1,
			expectedCurrentReleaseSequence: 2,
		});
		const response = await putApply(app, rollback);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			releaseSequence: 1,
			feedSequence: 3,
			status: "applied",
			idempotent: false,
		});
		await expect(currentIdentity()).resolves.toBe("signed rollback");
	});

	test("requires every signed rollback field and rejects expired rollback events", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 2,
						feedSequence: 1,
						releaseId: "agent-rollback-source",
						manifestRollbackTo: "agent-2026.07.13.1",
						manifestRollbackToSequence: 1,
					}),
				)
			).status,
		).toBe(200);

		for (const field of [
			"fromReleaseSequence",
			"toReleaseSequence",
			"toReleaseId",
			"allowDowngrade",
			"reason",
			"actor",
			"expiresAt",
		]) {
			const missing = signedApplyRequest({
				releaseSequence: 1,
				feedSequence: 2,
				publicationKind: "rollback",
				fromReleaseSequence: 2,
				expectedCurrentReleaseSequence: 2,
			});
			delete missing.signedFeed.publications[0][field];
			resignFeed(missing.signedFeed);
			missing.commandDigest = commandDigest(missing);
			const response = await putApply(app, missing);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_invalid_rollback",
			});
		}

		const expired = signedApplyRequest({
			releaseSequence: 1,
			feedSequence: 2,
			publicationKind: "rollback",
			fromReleaseSequence: 2,
			rollbackExpiresAt: "2020-01-01T00:00:00.000Z",
			expectedCurrentReleaseSequence: 2,
		});
		const expiredResponse = await putApply(app, expired);
		expect(expiredResponse.status).toBe(400);
		await expect(expiredResponse.json()).resolves.toMatchObject({
			error: "agent_release_rollback_expired",
		});
	});

	test("binds rollback from/to fields to current receipt and target manifest", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 2,
						feedSequence: 1,
						releaseId: "agent-rollback-current",
						manifestRollbackTo: "agent-2026.07.13.1",
						manifestRollbackToSequence: 1,
					}),
				)
			).status,
		).toBe(200);

		for (const request of [
			signedApplyRequest({
				releaseSequence: 1,
				feedSequence: 2,
				publicationKind: "rollback",
				fromReleaseSequence: 9,
				expectedCurrentReleaseSequence: 2,
			}),
			signedApplyRequest({
				releaseSequence: 1,
				feedSequence: 2,
				publicationKind: "rollback",
				fromReleaseSequence: 2,
				toReleaseSequence: 9,
				expectedCurrentReleaseSequence: 2,
			}),
			signedApplyRequest({
				releaseSequence: 1,
				feedSequence: 2,
				publicationKind: "rollback",
				fromReleaseSequence: 2,
				toReleaseId: "agent-wrong-target",
				expectedCurrentReleaseSequence: 2,
			}),
		]) {
			const response = await putApply(app, request);
			expect(response.status).toBe(409);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_rollback_target_mismatch",
			});
		}

		const nonDowngrade = signedApplyRequest({
			releaseSequence: 3,
			feedSequence: 2,
			publicationKind: "rollback",
			fromReleaseSequence: 2,
			expectedCurrentReleaseSequence: 2,
		});
		const nonDowngradeResponse = await putApply(app, nonDowngrade);
		expect(nonDowngradeResponse.status).toBe(400);
		await expect(nonDowngradeResponse.json()).resolves.toMatchObject({
			error: "agent_release_invalid_rollback",
		});
	});

	test("authorizes rollback only from the applied manifest's predeclared target", async () => {
		const app = await buildApp();
		const source = signedApplyRequest({
			releaseSequence: 42,
			feedSequence: 1,
			releaseId: "agent-release-42",
			manifestRollbackTo: "agent-release-35",
			manifestRollbackToSequence: 35,
		});
		expect((await putApply(app, source)).status).toBe(200);

		const rollback = signedApplyRequest({
			releaseSequence: 35,
			feedSequence: 2,
			releaseId: "agent-release-35",
			publicationKind: "rollback",
			fromReleaseSequence: 42,
			toReleaseId: "agent-release-35",
			toReleaseSequence: 35,
			expectedCurrentReleaseSequence: 42,
		});
		expect((await putApply(app, rollback)).status).toBe(200);
		await expect(currentIdentity()).resolves.toBe("release identity");
	});

	test("does not let a rollback target manifest authorize itself", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 42,
						feedSequence: 1,
						releaseId: "agent-release-42",
					}),
				)
			).status,
		).toBe(200);

		const selfAuthorizedTarget = signedApplyRequest({
			releaseSequence: 35,
			feedSequence: 2,
			releaseId: "agent-release-35",
			publicationKind: "rollback",
			fromReleaseSequence: 42,
			toReleaseId: "agent-release-35",
			toReleaseSequence: 35,
			manifestRollbackTo: "agent-release-34",
			manifestRollbackToSequence: 34,
			expectedCurrentReleaseSequence: 42,
		});
		const response = await putApply(app, selfAuthorizedTarget);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_rollback_not_authorized",
		});

		const selfReferentialTarget = signedApplyRequest({
			releaseSequence: 35,
			feedSequence: 2,
			releaseId: "agent-release-35",
			publicationKind: "rollback",
			fromReleaseSequence: 42,
			toReleaseId: "agent-release-35",
			toReleaseSequence: 35,
			manifestRollbackTo: "agent-release-35",
			manifestRollbackToSequence: 35,
			expectedCurrentReleaseSequence: 42,
		});
		const malformedResponse = await putApply(app, selfReferentialTarget);
		expect(malformedResponse.status).toBe(400);
		await expect(malformedResponse.json()).resolves.toMatchObject({
			error: "agent_release_invalid_rollback",
		});
	});

	test("persists the rollback target manifest's next chained rollback", async () => {
		const app = await buildApp();
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 42,
						feedSequence: 1,
						releaseId: "agent-release-42",
						manifestRollbackTo: "agent-release-35",
						manifestRollbackToSequence: 35,
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await putApply(
					app,
					signedApplyRequest({
						releaseSequence: 35,
						feedSequence: 2,
						releaseId: "agent-release-35",
						publicationKind: "rollback",
						fromReleaseSequence: 42,
						toReleaseId: "agent-release-35",
						toReleaseSequence: 35,
						manifestRollbackTo: "agent-release-34",
						manifestRollbackToSequence: 34,
						expectedCurrentReleaseSequence: 42,
					}),
				)
			).status,
		).toBe(200);
		const rows = await (await db())<{
			rollback_to_release_id: string | null;
			rollback_to_sequence: number | null;
		}>`
			SELECT rollback_to_release_id, rollback_to_sequence
			FROM agent_release_applies
			WHERE organization_id = ${ORG_ID} AND agent_id = ${AGENT_ID}
		`;
		expect(rows[0]).toMatchObject({
			rollback_to_release_id: "agent-release-34",
			rollback_to_sequence: 34,
		});
	});

	test("requires a manifest rollback target id and sequence as an older pair", async () => {
		const app = await buildApp();
		for (const request of [
			signedApplyRequest({
				releaseSequence: 42,
				manifestRollbackTo: "agent-release-35",
				manifestRollbackToSequence: 35,
				omitManifestRollbackTo: true,
			}),
			signedApplyRequest({
				releaseSequence: 42,
				manifestRollbackTo: "agent-release-35",
				manifestRollbackToSequence: 35,
				omitManifestRollbackToSequence: true,
			}),
		]) {
			const response = await putApply(app, request);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_invalid_rollback",
			});
		}
	});

	test("ordinary publications reject rollback-only fields", async () => {
		const app = await buildApp();
		const request = signedApplyRequest({});
		request.signedFeed.publications[0].fromReleaseSequence = 2;
		resignFeed(request.signedFeed);
		request.commandDigest = commandDigest(request);
		const response = await putApply(app, request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "agent_release_invalid_rollback",
		});
	});

	test("rejects top-level, nested, and escaped-equivalent duplicate JSON members", async () => {
		const app = await buildApp();
		const valid = JSON.stringify(signedApplyRequest({}));
		const duplicateBodies = [
			`{"commandDigest":"duplicate",${valid.slice(1)}`,
			valid.replace('"assignment":{', '"assignment":{"agentId":"duplicate",'),
			valid.replace(
				'"assignment":{',
				'"assignment":{"\\u0061gentId":"duplicate",',
			),
		];
		for (const body of duplicateBodies) {
			const response = await putRawApply(app, body);
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				error: "agent_release_duplicate_json_member",
			});
		}
		expect((await putRawApply(app, valid)).status).toBe(200);
	});

	test("serializes concurrent replicas through PostgreSQL row locks", async () => {
		const app = await buildApp();
		const low = signedApplyRequest({
			releaseSequence: 1,
			feedSequence: 1,
			releaseId: "agent-concurrent-1",
			managedSettings: { identityMd: "low" },
		});
		const high = signedApplyRequest({
			releaseSequence: 2,
			feedSequence: 2,
			releaseId: "agent-concurrent-2",
			managedSettings: { identityMd: "high" },
		});

		const responses = await Promise.all([
			putApply(app, low),
			putApply(app, high),
		]);
		const statuses = responses.map((response) => response.status).sort();
		expect(statuses).toEqual([200, 409]);
		const evidence = await app.request(
			`/api/provisioning/agents/${AGENT_ID}/managed-settings`,
		);
		expect(evidence.status).toBe(200);
		const body = await evidence.json();
		expect([1, 2]).toContain(body.releaseSequence);
	});
});

async function buildApp(
	options: {
		organizationId?: string;
		trustedPublicKeysJson?: string;
		agentReleaseEnvironment?: string;
		evidenceSigningPrivateKeysJson?: string;
	} = {},
) {
	const organizationId = options.organizationId ?? ORG_ID;
	const { createProvisioningRoutes } = await import(
		"../provisioning-routes.js"
	);
	const app = new Hono();
	app.onError((_error, c) => c.json({ error: "internal_error" }, 500));
	app.use("*", async (c, next) => {
		c.set("user", { id: "gateway-user" });
		c.set("session", { id: "pat:test-client" });
		c.set("organizationId", organizationId);
		c.set("authSource", "pat");
		c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
		return orgContext.run({ organizationId }, next);
	});
	app.route(
		"/api/provisioning",
		createProvisioningRoutes({
			agentReleaseTrustedPublicKeysJson:
				options.trustedPublicKeysJson ?? trustedPublicKeysJson(),
			agentReleaseEvidenceSigningPrivateKeysJson:
				options.evidenceSigningPrivateKeysJson ??
				evidenceSigningPrivateKeysJson(),
			agentReleaseEnvironment:
				options.agentReleaseEnvironment === undefined
					? "production"
					: options.agentReleaseEnvironment,
		}),
	);
	return app;
}

async function seedOrg(organizationId: string) {
	const sql = await db();
	await sql`
		INSERT INTO organization (id, name, slug)
		VALUES (${organizationId}, ${organizationId}, ${organizationId})
		ON CONFLICT (id) DO NOTHING
	`;
}

async function seedAgent() {
	const sql = await db();
	await sql`
		INSERT INTO agents (
			id, organization_id, name, owner_platform, owner_user_id,
			identity_md, soul_md, user_md, model_selection, tools_config,
			network_config, mcp_servers, skills_config, pre_approved_tools,
			guardrails, provider_model_preferences
		) VALUES (
			${AGENT_ID}, ${ORG_ID}, 'Irene Agent', 'toolbox', 'irene',
			'existing identity', 'existing soul', 'existing user',
			${sql.json({ mode: "auto" })}, ${sql.json({ strictMode: false })},
			${sql.json({ allowedDomains: ["existing.example"] })},
			${sql.json({ existing: { type: "streamable-http", url: "https://mcp.example" } })},
			${sql.json({ skills: [{ name: "existing" }] })},
			${sql.json(["existing_tool"])}, ${sql.json(["existing_guardrail"])},
			${sql.json({ openai: "openai/existing" })}
		)
	`;
}

async function db() {
	const { getDb } = await import("../../db/client.js");
	return getDb();
}

async function currentIdentity(): Promise<string | null> {
	const rows = await (await db())`
		SELECT identity_md
		FROM agents
		WHERE organization_id = ${ORG_ID} AND id = ${AGENT_ID}
	`;
	return rows[0]?.identity_md ?? null;
}

async function putApply(
	app: Hono,
	request: ReturnType<typeof signedApplyRequest>,
) {
	return app.request(`/api/provisioning/agents/${AGENT_ID}/managed-settings`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
}

async function putRawApply(app: Hono, body: string) {
	return app.request(`/api/provisioning/agents/${AGENT_ID}/managed-settings`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body,
	});
}

function signedApplyRequest(options: ReleaseFixtureOptions) {
	const releaseSequence = options.releaseSequence ?? 1;
	const feedSequence = options.feedSequence ?? 1;
	const environment = options.environment ?? "production";
	const releaseId = options.releaseId ?? `agent-2026.07.13.${releaseSequence}`;
	const keyId = options.keyId ?? KEY_ID;
	const manifest = {
		releaseId,
		releaseSequence,
		environment,
		releaseKind: "capability_activation",
		createdAt: options.createdAt ?? "2026-07-13T13:00:00.000Z",
		managedSettings: options.managedSettings ?? {
			identityMd: "release identity",
		},
		...(options.manifestRollbackTo !== undefined ||
		options.manifestRollbackToSequence !== undefined
			? {
					...(options.omitManifestRollbackToSequence
						? {}
						: {
								rollbackToSequence:
									options.manifestRollbackToSequence ?? releaseSequence,
							}),
					...(options.omitManifestRollbackTo
						? {}
						: { rollbackTo: options.manifestRollbackTo ?? releaseId }),
				}
			: {}),
	};
	const signedManifest = {
		...manifest,
		signing: {
			algorithm: "Ed25519",
			keyId,
			signature: signValue({
				...manifest,
				signing: { algorithm: "Ed25519", keyId },
			}),
		},
	};
	const publication: Record<string, unknown> = {
		releaseId,
		releaseSequence,
		manifestDigest: digestValue(signedManifest),
		manifest: structuredClone(signedManifest),
		publicationKind: options.publicationKind ?? "release",
	};
	if (options.publicationKind === "rollback") {
		publication.fromReleaseSequence =
			options.fromReleaseSequence ?? releaseSequence + 1;
		publication.toReleaseSequence =
			options.toReleaseSequence ?? releaseSequence;
		publication.toReleaseId = options.toReleaseId ?? releaseId;
		publication.allowDowngrade = options.allowDowngrade ?? true;
		publication.reason = options.rollbackReason ?? "rollback test fixture";
		publication.actor = options.rollbackActor ?? "release-operator@test";
		publication.expiresAt =
			options.rollbackExpiresAt ?? "2099-07-13T13:02:00.000Z";
	}
	const unsignedFeed = {
		feedVersion: 1,
		feedSequence,
		environment,
		channel: options.channel ?? "candidate",
		generatedAt: options.generatedAt ?? "2026-07-13T13:01:00.000Z",
		publications: [publication],
	};
	const signedFeed = {
		...unsignedFeed,
		feedSigning: {
			algorithm: "Ed25519",
			keyId,
			signature: signValue({
				...unsignedFeed,
				feedSigning: { algorithm: "Ed25519", keyId },
			}),
		},
	};
	const request = {
		signedManifest,
		signedFeed,
		assignment: {
			environment,
			targetId: "target-irene",
			toolboxUserId: "irene",
			agentId: options.agentId ?? AGENT_ID,
		},
		expectedCurrentReleaseSequence:
			options.expectedCurrentReleaseSequence ?? null,
		commandDigest: "",
	};
	request.commandDigest = commandDigest(request);
	return request;
}

function latestSignedApplyRequest() {
	const managedSettings = {
		identityMd: "release identity",
		soulMd: "release soul",
		userMd: "release user",
		modelSelection: { mode: "auto" as const },
		toolsConfig: {
			allowedTools: ["manage_schedules"],
			strictMode: true,
			mcpExposure: "tools" as const,
		},
	};
	const request = signedApplyRequest({ managedSettings });
	const controlPlanePolicy = {
		eligibility: {
			minimumSourceSequence: null,
			maximumSourceSequence: null,
			freshInstallAllowed: true,
			requiredAppliedCapabilities: [],
			requiredIntermediateSequences: [],
			cohortAlgorithmVersion: "hmac-sha256-toolbox-user-v1",
		},
		rolloutPolicy: {
			kind: "standard",
			stages: [100],
			gates: {
				minimumCanaries: 2,
				minimumCanaryObservationMinutes: 30,
				requiredSmokeNames: ["managed-settings-contract"],
			},
		},
		requiredCarriers: [
			{
				component: "lobu-runtime",
				revision: "test-runtime",
				origin: "https://shifulobu.zeabur.app",
				provides: ["managed_settings.apply.v1"],
				requires: [],
				imageDigest: `sha256:${"1".repeat(64)}`,
			},
		],
		baseline: {
			settingsHash: digestValue(managedSettings),
			fullBundleDigest: `sha256:${"2".repeat(64)}`,
			patches: [],
		},
		capabilities: [
			{
				name: "wake-agent",
				requires: ["lobu-runtime:managed_settings.apply.v1"],
				smokes: ["managed-settings-contract"],
			},
		],
		migrations: { required: [], backwardCompatible: true },
		rollbackStrategy: {
			kind: "forward_compatible_managed_settings",
			backwardCompatible: true,
			boundedDriftMinutes: 60,
		},
	};
	const unsignedManifest = {
		...withoutKey(request.signedManifest, "signing"),
		controlPlanePolicy,
	};
	request.signedManifest = {
		...unsignedManifest,
		signing: {
			algorithm: "Ed25519",
			keyId: KEY_ID,
			signature: signValue({
				...unsignedManifest,
				signing: { algorithm: "Ed25519", keyId: KEY_ID },
			}),
		},
	};
	request.signedFeed.publications[0].manifest = structuredClone(
		request.signedManifest,
	);
	request.signedFeed.publications[0].manifestDigest = digestValue(
		request.signedManifest,
	);
	const unsignedFeed = {
		...withoutKey(request.signedFeed, "feedSigning"),
		activationMode: "per_agent" as const,
		rollout: {
			percentage: 100,
			paused: false,
			cohortAlgorithmVersion: "hmac-sha256-toolbox-user-v1" as const,
		},
	};
	request.signedFeed = {
		...unsignedFeed,
		feedSigning: {
			algorithm: "Ed25519",
			keyId: KEY_ID,
			signature: signValue({
				...unsignedFeed,
				feedSigning: { algorithm: "Ed25519", keyId: KEY_ID },
			}),
		},
	};
	const latest = Object.assign(request, {
		assignment: {
			...request.assignment,
			targetId: "44444444-4444-4444-8444-444444444444",
		},
		assignmentRevision: "11111111-1111-4111-8111-111111111111",
		claimToken: "22222222-2222-4222-8222-222222222222",
		stepOrdinal: 0,
		stepLeaseToken: "33333333-3333-4333-8333-333333333333",
	});
	latest.commandDigest = commandDigest(latest);
	return latest;
}

function resignLatestRequest(
	request: ReturnType<typeof latestSignedApplyRequest>,
) {
	const unsignedManifest = withoutKey(request.signedManifest, "signing");
	request.signedManifest.signing.signature = signValue({
		...unsignedManifest,
		signing: {
			algorithm: "Ed25519",
			keyId: request.signedManifest.signing.keyId,
		},
	});
	request.signedFeed.publications[0].manifest = structuredClone(
		request.signedManifest,
	);
	request.signedFeed.publications[0].manifestDigest = digestValue(
		request.signedManifest,
	);
	const unsignedFeed = withoutKey(request.signedFeed, "feedSigning");
	request.signedFeed.feedSigning.signature = signValue({
		...unsignedFeed,
		feedSigning: {
			algorithm: "Ed25519",
			keyId: request.signedFeed.feedSigning.keyId,
		},
	});
	request.commandDigest = commandDigest(request);
}

function testRuntimeCarrierPolicy() {
	return {
		backwardCompatible: true as const,
		backwardCompatibilitySmokes: ["runtime-backward-compatibility"],
		boundedDriftMinutes: 60,
		requiredOperationalEvidence: [
			"runtime-queue",
			"runtime-database",
			"runtime-health",
		],
		previousStable: { releaseId: "runtime-previous", releaseSequence: 1 },
		queueConsumer: {
			identity: "lobu-queue-consumer",
			origin: "https://shifulobu.zeabur.app",
			evidenceName: "runtime-queue",
		},
		databaseConsumer: {
			identity: "lobu-database-consumer",
			origin: "https://shifulobu.zeabur.app",
			evidenceName: "runtime-database",
		},
	};
}

function resignFeed(feed: ReturnType<typeof signedApplyRequest>["signedFeed"]) {
	const { signature: _signature, ...feedSigning } = feed.feedSigning;
	void _signature;
	feed.feedSigning.signature = signValue({
		...withoutKey(feed, "feedSigning"),
		feedSigning,
	});
}

function commandDigest(request: Record<string, unknown>): string {
	return digestValue(withoutKey(request, "commandDigest"));
}

function digestValue(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalizeForTest(value)).digest("hex")}`;
}

function signValue(value: unknown): string {
	return signBytes(
		null,
		Buffer.from(canonicalizeForTest(value)),
		createPrivateKey(PRIVATE_KEY),
	).toString("base64");
}

function canonicalizeForTest(value: unknown): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map(canonicalizeForTest).join(",")}]`;
	if (typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalizeForTest((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	}
	throw new Error(`Unsupported test fixture value: ${typeof value}`);
}

function withoutKey<T extends Record<string, unknown>>(value: T, key: string) {
	const clone = { ...value };
	delete clone[key];
	return clone;
}

function trustedPublicKeysJson(): string {
	const der = createPublicKey(PUBLIC_KEY).export({
		type: "spki",
		format: "der",
	});
	return JSON.stringify({ [KEY_ID]: der.toString("base64") });
}

function evidenceSigningPrivateKeysJson(): string {
	return JSON.stringify({
		activeKeyId: EVIDENCE_KEY_ID,
		keys: { [EVIDENCE_KEY_ID]: evidencePrivateKeyDer() },
	});
}

function evidencePrivateKeyDer(): string {
	return createPrivateKey(PRIVATE_KEY)
		.export({
			type: "pkcs8",
			format: "der",
		})
		.toString("base64");
}
