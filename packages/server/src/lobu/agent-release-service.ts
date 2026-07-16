import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign as signBytes,
	verify as verifySignature,
} from "node:crypto";
import type { AgentSettings, ReleaseCapabilityClaim } from "@lobu/core";
import { canonicalize } from "json-canonicalize";
import { type DbClient, getDb } from "../db/client.js";
import type { RuntimeCapabilitySnapshot } from "../gateway/services/runtime-capability-snapshot.js";
import {
	replaceAgentSettings,
	syncProvisioningGrantsInTransaction,
} from "./legacy-agent-settings-service.js";
import { parseStrictJsonBytes } from "./strict-json-parser.js";

const MANAGED_SETTING_KEYS = [
	"identityMd",
	"soulMd",
	"userMd",
	"modelSelection",
	"toolsConfig",
] as const;
// Lobu persists and reads these fields from live agent state. The remaining
// personal baseline fields are signed, immutable source metadata only; they
// may seed live digest reconstruction but can never mask a mutable field.
const PERSONAL_BASELINE_LOBU_OWNED_KEYS = [
	"identityMd",
	"soulMd",
	"userMd",
	"mcpServers",
	"skillsConfig",
	"preApprovedTools",
	"modelSelection",
	"providerModelPreferences",
	"networkConfig",
	"egressConfig",
	"nixConfig",
	"toolsConfig",
	"pluginsConfig",
	"guardrails",
	"installedProviders",
] as const;
const PERSONAL_BASELINE_IMMUTABLE_METADATA_KEYS = [
	"templateKey",
	"scope",
	"baselinePrompt",
	"runtimeConfig",
] as const;
const PERSONAL_BASELINE_SETTING_KEYS = [
	...PERSONAL_BASELINE_IMMUTABLE_METADATA_KEYS,
	...PERSONAL_BASELINE_LOBU_OWNED_KEYS,
] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PERSONAL_BASELINE_VERSION_PATTERN =
	/^personal-agent-baseline-v1-[0-9a-f]{64}$/;
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_KEYRING_BYTES = 64 * 1024;
const MAX_KEYRING_KEYS = 32;
const RFC3339_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

type AgentReleaseEnvironment = "local" | "staging" | "production";
type PublicationKind = "release" | "rollback" | "pause";

interface ControlPlanePolicy {
	baseline: null | {
		settingsHash: string;
		fullBundleDigest: string;
		patches: unknown[];
	};
	personalAgentBaseline?: PersonalAgentBaselineContract;
	[key: string]: unknown;
}

interface PersonalAgentBaselineContract {
	baselineVersionId: string;
	baselineVersion: number;
	templateKey: "pm-marketing-user-agent";
	materializationVersion: 1;
	sourceRepository: "shifu-tw/shifu-toolbox";
	sourceRevision: string;
	sourcePath: string;
	sourceDigest: string;
	effectiveSettingsDigest: string;
	componentDigests: Record<string, string>;
}

interface ManagedModelSelection {
	mode: "auto" | "pinned";
	pinnedModel?: string;
}

interface ManagedToolsConfig {
	allowedTools?: string[];
	deniedTools?: string[];
	strictMode?: boolean;
	mcpExposure?: "tools" | "cli";
}

interface ManagedSettings {
	identityMd?: string;
	soulMd?: string;
	userMd?: string;
	modelSelection?: ManagedModelSelection;
	toolsConfig?: ManagedToolsConfig;
}

interface SigningMetadata {
	algorithm: "Ed25519";
	keyId: string;
	signature: string;
}

interface SignedManifest {
	releaseId: string;
	releaseSequence: number;
	environment: AgentReleaseEnvironment;
	releaseKind: "capability_activation" | "runtime_carrier";
	createdAt: string;
	managedSettings: ManagedSettings;
	controlPlanePolicy?: ControlPlanePolicy;
	rollbackToSequence?: number;
	rollbackTo?: string;
	signing: SigningMetadata;
}

interface FeedPublication {
	releaseId: string;
	releaseSequence: number;
	manifestDigest: string;
	manifest: SignedManifest;
	publicationKind?: PublicationKind;
	fromReleaseSequence?: number;
	toReleaseSequence?: number;
	toReleaseId?: string;
	allowDowngrade?: true;
	reason?: string;
	actor?: string;
	expiresAt?: string;
}

interface SignedFeed {
	feedVersion: 1;
	feedSequence: number;
	environment: AgentReleaseEnvironment;
	channel: "candidate" | "stable";
	generatedAt: string;
	publications: FeedPublication[];
	activationMode?: "per_agent" | "shared_carrier";
	rollout?: {
		percentage: number;
		paused: boolean;
		cohortAlgorithmVersion: "hmac-sha256-toolbox-user-v1";
	};
	feedSigning: SigningMetadata;
}

interface ReleaseAssignment {
	environment: AgentReleaseEnvironment;
	targetId: string;
	toolboxUserId: string;
	agentId: string;
}

export interface BaselineOverrideProvenance {
	kind: "break_glass";
	recordId: string;
	incidentReference: string;
	operatorUserId: string;
	reason: string;
	approvedAt: string;
	expiresAt: string;
	anchoredReleaseId: string;
	anchoredReleaseSequence: number;
	anchoredFeedSequence: number;
	anchoredFeedDigest: string;
	anchoredManifestDigest: string;
	anchoredBaselineVersionId: string;
	anchoredBaselineVersion: number;
	anchoredEffectiveSettingsDigest: string;
	overrideBaselineVersionId: string;
	overrideBaselineVersion: number;
	overrideEffectiveSettingsDigest: string;
}

export interface AgentReleaseApplyCommand {
	signedManifest: SignedManifest;
	signedFeed: SignedFeed;
	assignment: ReleaseAssignment;
	expectedCurrentReleaseSequence: number | null;
	assignmentRevision?: string;
	claimToken?: string;
	stepOrdinal?: number;
	stepLeaseToken?: string;
	settings?: Record<string, unknown>;
	baselineVersionId?: string;
	baselineVersion?: number;
	effectiveSettingsDigest?: string;
	baselineOverride?: BaselineOverrideProvenance;
	commandDigest: string;
}

export interface AgentReleaseEvidence {
	ok: true;
	agentId: string;
	releaseId: string;
	releaseSequence: number;
	feedSequence: number;
	channel: "candidate" | "stable";
	feedDigest: string;
	manifestDigest: string;
	status: "applied" | "drifted";
	revisionRef: string;
	settingsHash: string;
	baselineVersionId?: string;
	effectiveSettingsDigest?: string;
	baselineOverride?: BaselineOverrideProvenance;
	liveSettingsHash?: string;
	appliedAt: string;
}

export interface AgentReleasePostApplyEvidence {
	evidenceKind: "post_apply";
	environment: AgentReleaseEnvironment;
	targetId: string;
	agentId: string;
	assignmentRevision: string;
	claimToken: string;
	stepOrdinal: number;
	stepLeaseToken: string;
	releaseId: string;
	releaseSequence: number;
	feedSequence: number;
	feedDigest: string;
	manifestDigest: string;
	revisionRef: string | null;
	settingsHash: string;
	baselineVersionId?: string;
	effectiveSettingsDigest?: string;
	baselineOverride?: BaselineOverrideProvenance;
	drifted: boolean;
	postApplySmoke: { passed: boolean; digest: string };
	observedAt: string;
	expiresAt: string;
	evidenceRef: string;
	evidenceSigning: SigningMetadata;
}

export interface AgentReleaseApplyResult extends AgentReleaseEvidence {
	idempotent: boolean;
	repaired: boolean;
}

export class AgentReleaseError extends Error {
	constructor(
		readonly code: string,
		readonly status: 400 | 403 | 404 | 409 | 503,
		message: string,
	) {
		super(message);
		this.name = "AgentReleaseError";
	}
}

type ReleaseCapabilityState =
	| { status: "legacy_unenrolled" }
	| { status: "enrolled_inactive" }
	| { status: "active"; claim: ReleaseCapabilityClaim };

export interface ReleaseCapabilityAgentRow extends AgentSettingsRow {
	owner_user_id: string;
}

export interface ReleaseCapabilityReceiptRow {
	environment: AgentReleaseEnvironment;
	desired_release_id: string;
	desired_release_sequence: number;
	desired_feed_sequence: number;
	applied_release_id: string;
	applied_release_sequence: number;
	applied_feed_sequence: number;
	status: string;
	settings_hash: string;
	personal_baseline_settings?: Record<string, unknown> | null;
}

export function classifyAgentReleaseCapabilityState(input: {
	agent: ReleaseCapabilityAgentRow;
	receipt: ReleaseCapabilityReceiptRow | null;
	agentId: string;
	environment: "staging" | "production";
	snapshot: RuntimeCapabilitySnapshot | null;
}): ReleaseCapabilityState {
	const { agent, receipt, snapshot } = input;
	if (!receipt) return { status: "legacy_unenrolled" };
	if (
		!snapshot ||
		receipt.environment !== input.environment ||
		receipt.status !== "applied" ||
		receipt.settings_hash !==
			settingsHashFromAgent(agent, receipt.personal_baseline_settings) ||
		receipt.desired_release_id !== receipt.applied_release_id ||
		receipt.desired_release_sequence !== receipt.applied_release_sequence ||
		receipt.desired_feed_sequence !== receipt.applied_feed_sequence ||
		snapshot.environment !== input.environment ||
		snapshot.toolboxUserId !== agent.owner_user_id ||
		snapshot.agentId !== input.agentId ||
		snapshot.appliedReleaseId !== receipt.applied_release_id ||
		snapshot.appliedReleaseSequence !== receipt.applied_release_sequence
	)
		return { status: "enrolled_inactive" };
	return {
		status: "active",
		claim: {
			environment: snapshot.environment,
			toolboxUserId: snapshot.toolboxUserId,
			agentId: snapshot.agentId,
			releaseId: snapshot.appliedReleaseId,
			releaseSequence: snapshot.appliedReleaseSequence,
			snapshotDigest: snapshot.snapshotDigest,
			expiresAt: snapshot.expiresAt,
			capabilityIds: [...snapshot.capabilities],
		},
	};
}

/** Reads durable enrollment before deciding whether a Toolbox snapshot may grant a run claim. */
export async function readAgentReleaseCapabilityState(input: {
	organizationId: string;
	agentId: string;
	environment: "staging" | "production";
	snapshot: RuntimeCapabilitySnapshot | null;
	sql?: DbClient;
}): Promise<ReleaseCapabilityState> {
	const sql = input.sql ?? getDb();
	const rows = await sql<
		ReleaseCapabilityReceiptRow & ReleaseCapabilityAgentRow
	>`
		SELECT a.owner_user_id, a.identity_md, a.soul_md, a.user_md,
		       a.model, a.model_selection, a.provider_model_preferences,
		       a.network_config, a.egress_config, a.nix_config, a.mcp_servers,
		       a.skills_config, a.tools_config, a.plugins_config, a.installed_providers,
		       a.verbose_logging, a.pre_approved_tools, a.guardrails,
		       r.settings_hash, r.environment, r.personal_baseline_settings,
		       r.desired_release_id, r.desired_release_sequence, r.desired_feed_sequence,
		       r.applied_release_id, r.applied_release_sequence, r.applied_feed_sequence,
		       r.status
		FROM agent_release_applies r
		JOIN agents a ON a.organization_id = r.organization_id AND a.id = r.agent_id
		WHERE r.organization_id = ${input.organizationId} AND r.agent_id = ${input.agentId}
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) return { status: "legacy_unenrolled" };
	const state = classifyAgentReleaseCapabilityState({
		agent: row,
		receipt: row,
		agentId: input.agentId,
		environment: input.environment,
		snapshot: input.snapshot,
	});
	if (state.status === "active") {
		const claim = state.claim;
		await sql`
			INSERT INTO public.agent_release_capability_snapshots (
				organization_id, agent_id, release_id, release_sequence,
				snapshot_digest, capability_ids, observed_at, expires_at
			)
			SELECT r.organization_id, r.agent_id, r.applied_release_id, r.applied_release_sequence,
			       ${claim.snapshotDigest}, ${JSON.stringify(claim.capabilityIds)}::jsonb, now(), ${claim.expiresAt}
			FROM public.agent_release_applies r
			WHERE r.organization_id = ${input.organizationId}
			  AND r.agent_id = ${input.agentId}
			  AND r.status = 'applied'
			  AND r.applied_release_id = ${claim.releaseId}
			  AND r.applied_release_sequence = ${claim.releaseSequence}
			  AND r.desired_release_id = r.applied_release_id
			  AND r.desired_release_sequence = r.applied_release_sequence
			  AND r.desired_feed_sequence = r.applied_feed_sequence
			ON CONFLICT DO NOTHING
		`;
	}
	return state;
}

export function createAgentReleaseService(options: {
	trustedPublicKeysJson?: string;
	evidenceSigningPrivateKeysJson?: string;
	expectedEnvironment?: string;
	now?: () => Date;
	sql?: DbClient;
	/** Test barrier invoked while the transaction owns the agent row lock. */
	transactionHooks?: {
		afterAgentLock?: () => Promise<void>;
	};
}) {
	const keyring = parseTrustedKeyring(options.trustedPublicKeysJson);
	const expectedEnvironment = parseExpectedEnvironment(
		options.expectedEnvironment,
	);
	const evidenceSigner = parseEvidenceSigner(
		options.evidenceSigningPrivateKeysJson,
	);

	return {
		async apply(input: {
			organizationId: string;
			agentId: string;
			command: unknown;
		}): Promise<AgentReleaseApplyResult | AgentReleasePostApplyEvidence> {
			const sql = options.sql ?? getDb();
			if (keyring.error) throw keyring.error;
			if (expectedEnvironment.error) throw expectedEnvironment.error;
			assertAgentReleaseJsonValue(input.command);
			const command = parseApplyCommand(input.command);
			validateApplyEnvelope(input.agentId, command, expectedEnvironment.value);
			verifySignedManifest(command.signedManifest, keyring.keys);
			verifySignedFeed(command.signedFeed, keyring.keys);
			validateCurrentContract(command);
			const publication = validatePublication(
				command,
				(options.now ?? (() => new Date()))(),
			);
			const feedDigest = digestValue(command.signedFeed);
			const expectedCommandDigest = digestValue(
				withoutOwnKey(command, "commandDigest"),
			);
			if (!safeDigestEqual(command.commandDigest, expectedCommandDigest)) {
				throw releaseError(
					"agent_release_command_digest_mismatch",
					400,
					"Agent release command digest does not match its canonical payload",
				);
			}
			validatePersonalBaselineCommand(
				command,
				(options.now ?? (() => new Date()))(),
			);
			if (isCurrentApplyCommand(command) && evidenceSigner.error) {
				throw evidenceSigner.error;
			}

			const result = await sql.begin(async (tx) =>
				applyInTransaction(tx, {
					organizationId: input.organizationId,
					agentId: input.agentId,
					command,
					publication,
					feedDigest,
					transactionHooks: options.transactionHooks,
				}),
			);
			if (!isCurrentApplyCommand(command)) return result;
			return signPostApplyEvidence({
				command,
				result,
				signer: evidenceSigner.value,
				now: (options.now ?? (() => new Date()))(),
			});
		},

		async getEvidence(input: {
			organizationId: string;
			agentId: string;
		}): Promise<AgentReleaseEvidence | null> {
			const sql = options.sql ?? getDb();
			if (expectedEnvironment.error) throw expectedEnvironment.error;
			return sql.begin(async (tx) => {
				const rows = await tx<ReceiptWithAgentRow>`
				SELECT r.applied_release_id, r.applied_release_sequence,
				       r.applied_feed_sequence, r.applied_channel,
				       r.applied_feed_digest, r.environment,
				       r.rollback_to_release_id, r.rollback_to_sequence,
				       r.manifest_digest, r.status,
				       r.revision_ref, r.settings_hash, r.applied_at,
				       r.personal_baseline_version_id,
				       r.personal_baseline_effective_settings_digest,
				       r.personal_baseline_settings,
				       r.baseline_override,
				       r.baseline_override_digest,
				       a.owner_user_id, a.identity_md, a.soul_md, a.user_md,
				       a.model, a.model_selection, a.provider_model_preferences,
				       a.network_config, a.egress_config, a.nix_config, a.mcp_servers,
				       a.skills_config, a.tools_config, a.plugins_config,
				       a.installed_providers, a.verbose_logging,
				       a.pre_approved_tools, a.guardrails
				FROM agent_release_applies r
				JOIN agents a
				  ON a.organization_id = r.organization_id
				 AND a.id = r.agent_id
				WHERE r.organization_id = ${input.organizationId}
				  AND r.agent_id = ${input.agentId}
				LIMIT 1
				FOR SHARE OF r, a
			`;
				if (rows[0] && rows[0].environment !== expectedEnvironment.value) {
					throw releaseError(
						"agent_release_receipt_environment_mismatch",
						409,
						"Agent release evidence belongs to another runtime environment",
					);
				}
				if (!rows[0]) return null;
				const evidence = evidenceFromReceipt(input.agentId, rows[0]);
				const liveSettingsHash = settingsHashFromAgent(
					rows[0],
					rows[0].personal_baseline_settings,
				);
				return liveSettingsHash === rows[0].settings_hash
					? evidence
					: { ...evidence, status: "drifted", liveSettingsHash };
			});
		},
	};
}

async function applyInTransaction(
	tx: DbClient,
	input: {
		organizationId: string;
		agentId: string;
		command: AgentReleaseApplyCommand;
		publication: FeedPublication;
		feedDigest: string;
		transactionHooks?: {
			afterAgentLock?: () => Promise<void>;
		};
	},
): Promise<AgentReleaseApplyResult> {
	const agentRows = await tx<AgentSettingsRow>`
		SELECT owner_user_id, identity_md, soul_md, user_md, model,
		       model_selection, provider_model_preferences, network_config,
		       egress_config, nix_config, mcp_servers, skills_config, tools_config,
		       plugins_config, installed_providers, verbose_logging,
		       pre_approved_tools, guardrails
		FROM agents
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.agentId}
		FOR UPDATE
	`;
	const agent = agentRows[0];
	if (!agent) {
		throw releaseError(
			"agent_release_agent_not_found",
			404,
			"Agent release target does not exist in the authenticated organization",
		);
	}
	await input.transactionHooks?.afterAgentLock?.();
	if (agent.owner_user_id !== input.command.assignment.toolboxUserId) {
		throw releaseError(
			"agent_release_assignment_target_mismatch",
			404,
			"Agent release assignment does not match the Lobu agent owner",
		);
	}

	const receiptRows = await tx<ReceiptRow>`
		SELECT desired_release_id, desired_release_sequence, desired_feed_sequence,
		       applied_release_id, applied_release_sequence, applied_feed_sequence,
		       applied_channel, applied_feed_digest, environment,
		       rollback_to_release_id, rollback_to_sequence,
		       manifest_digest, status, revision_ref, settings_hash, applied_at,
		       personal_baseline_version_id,
		       personal_baseline_effective_settings_digest, personal_baseline_settings,
		       baseline_override, baseline_override_digest
		FROM agent_release_applies
		WHERE organization_id = ${input.organizationId}
		  AND agent_id = ${input.agentId}
		FOR UPDATE
	`;
	const current = receiptRows[0] ?? null;
	const manifest = input.command.signedManifest;
	const feed = input.command.signedFeed;
	const manifestDigest = input.publication.manifestDigest;
	if (current && current.environment !== manifest.environment) {
		throw releaseError(
			"agent_release_receipt_environment_mismatch",
			409,
			"Agent release receipt belongs to another runtime environment",
		);
	}

	const cursorRows = await tx<FeedCursorRow>`
		SELECT highest_feed_sequence, highest_feed_digest
		FROM agent_release_feed_cursors
		WHERE organization_id = ${input.organizationId}
		  AND agent_id = ${input.agentId}
		  AND environment = ${manifest.environment}
		  AND channel = ${feed.channel}
		FOR UPDATE
	`;
	const cursor = cursorRows[0] ?? null;
	if (cursor && feed.feedSequence < cursor.highest_feed_sequence) {
		throw releaseError(
			"agent_release_feed_replay",
			409,
			"Agent release feed sequence is older than the channel cursor",
		);
	}
	if (
		cursor &&
		feed.feedSequence === cursor.highest_feed_sequence &&
		cursor.highest_feed_digest !== input.feedDigest
	) {
		throw releaseError(
			"agent_release_feed_sequence_conflict",
			409,
			"Agent release feed sequence was already observed with different signed bytes",
		);
	}

	if (current?.applied_release_sequence === manifest.releaseSequence) {
		if (
			isCurrentApplyCommand(input.command) &&
			input.command.expectedCurrentReleaseSequence !==
				current.applied_release_sequence
		) {
			throw releaseError(
				"agent_release_expected_current_mismatch",
				409,
				"Agent release compare-and-set precondition does not match",
			);
		}
		if (
			current.manifest_digest !== manifestDigest ||
			current.applied_release_id !== manifest.releaseId
		) {
			throw releaseError(
				"agent_release_sequence_conflict",
				409,
				"Agent release sequence was already applied with another manifest",
			);
		}
		assertRetryMatchesReceipt(current, input.command);
		const liveSettingsHash = settingsHashFromAgent(
			agent,
			current.personal_baseline_settings,
		);
		const repaired = liveSettingsHash !== current.settings_hash;
		const repairedAgent = repaired
			? await applyCommandSettings(tx, input)
			: agent;
		const repairedSettingsHash = repaired
			? settingsHashFromAgent(repairedAgent, input.command.settings)
			: current.settings_hash;
		assertExpectedSettingsHash(input.command, repairedSettingsHash);
		if (repaired && repairedSettingsHash !== current.settings_hash) {
			throw releaseError(
				"agent_release_settings_drift_unrepairable",
				409,
				"Signed managed settings cannot restore the complete expected projection",
			);
		}
		await writeFeedCursor(tx, input, cursor);
		if (
			repaired ||
			feed.feedSequence !== current.applied_feed_sequence ||
			feed.channel !== current.applied_channel ||
			input.feedDigest !== current.applied_feed_digest
		) {
			const advancedRows = await tx<ReceiptRow>`
				UPDATE agent_release_applies SET
					desired_feed_sequence = ${feed.feedSequence},
					applied_feed_sequence = ${feed.feedSequence},
					applied_channel = ${feed.channel},
					applied_feed_digest = ${input.feedDigest},
					settings_hash = ${current.settings_hash},
					updated_at = NOW()
				WHERE organization_id = ${input.organizationId}
				  AND agent_id = ${input.agentId}
				RETURNING desired_release_id, desired_release_sequence, desired_feed_sequence,
				          applied_release_id, applied_release_sequence, applied_feed_sequence,
				          applied_channel, applied_feed_digest, environment,
				          rollback_to_release_id, rollback_to_sequence,
				          manifest_digest, status, revision_ref, settings_hash, applied_at,
				          personal_baseline_version_id,
				          personal_baseline_effective_settings_digest,
				          personal_baseline_settings, baseline_override,
				          baseline_override_digest
			`;
			return {
				...evidenceFromReceipt(input.agentId, advancedRows[0]),
				idempotent: !repaired,
				repaired,
			};
		}
		return {
			...evidenceFromReceipt(input.agentId, current),
			idempotent: true,
			repaired: false,
		};
	}

	const currentReleaseSequence = current?.applied_release_sequence ?? null;
	if (input.command.expectedCurrentReleaseSequence !== currentReleaseSequence) {
		throw releaseError(
			"agent_release_expected_current_mismatch",
			409,
			"Agent release compare-and-set precondition does not match",
		);
	}

	const publicationKind = input.publication.publicationKind ?? "release";
	if (current && manifest.releaseSequence < current.applied_release_sequence) {
		if (publicationKind !== "rollback") {
			throw releaseError(
				"agent_release_stale",
				409,
				"An older ordinary agent release cannot replace a newer applied release",
			);
		}
		if (
			input.publication.fromReleaseSequence !==
				current.applied_release_sequence ||
			input.publication.fromReleaseSequence !== current.desired_release_sequence
		) {
			throw releaseError(
				"agent_release_rollback_target_mismatch",
				409,
				"Signed rollback source does not match the current receipt",
			);
		}
		if (
			current.rollback_to_release_id === null ||
			current.rollback_to_sequence === null
		) {
			throw releaseError(
				"agent_release_rollback_not_authorized",
				409,
				"The applied manifest did not pre-authorize a rollback target",
			);
		}
		if (
			input.publication.toReleaseId !== current.rollback_to_release_id ||
			input.publication.toReleaseSequence !== current.rollback_to_sequence
		) {
			throw releaseError(
				"agent_release_rollback_target_mismatch",
				409,
				"Signed rollback target does not match the applied manifest authorization",
			);
		}
	} else if (publicationKind === "rollback") {
		throw releaseError(
			"agent_release_invalid_rollback",
			400,
			"A rollback publication must target an older release from the current sequence",
		);
	}
	await writeFeedCursor(tx, input, cursor);

	const updated = await applyCommandSettings(tx, input);
	const settingsHash = settingsHashFromAgent(updated, input.command.settings);
	assertExpectedSettingsHash(input.command, settingsHash);
	const revisionRef = [
		"lobu",
		input.agentId,
		"agent-release",
		String(manifest.releaseSequence),
		manifestDigest.slice("sha256:".length, "sha256:".length + 12),
	].join(":");

	const receipt = await tx<ReceiptRow>`
		INSERT INTO agent_release_applies (
			organization_id, agent_id, environment,
			desired_release_id, desired_release_sequence, desired_feed_sequence,
			applied_release_id, applied_release_sequence, applied_feed_sequence,
			applied_channel, applied_feed_digest,
			rollback_to_release_id, rollback_to_sequence,
			manifest_digest, status, revision_ref, settings_hash, error_code,
			personal_baseline_version_id, personal_baseline_effective_settings_digest,
			personal_baseline_settings, baseline_override, baseline_override_digest,
			created_at, updated_at, applied_at
		) VALUES (
			${input.organizationId}, ${input.agentId}, ${manifest.environment},
			${manifest.releaseId}, ${manifest.releaseSequence}, ${feed.feedSequence},
			${manifest.releaseId}, ${manifest.releaseSequence}, ${feed.feedSequence},
			${feed.channel}, ${input.feedDigest},
			${manifest.rollbackTo ?? null}, ${manifest.rollbackToSequence ?? null},
			${manifestDigest}, 'applied', ${revisionRef}, ${settingsHash}, NULL,
			${input.command.baselineVersionId ?? null},
			${input.command.effectiveSettingsDigest ?? null},
			${input.command.settings ? tx.json(input.command.settings) : null},
			${input.command.baselineOverride ? tx.json(input.command.baselineOverride) : null},
			${input.command.baselineOverride ? digestValue(input.command.baselineOverride) : null},
			NOW(), NOW(), NOW()
		)
		ON CONFLICT (organization_id, agent_id) DO UPDATE SET
			environment = EXCLUDED.environment,
			desired_release_id = EXCLUDED.desired_release_id,
			desired_release_sequence = EXCLUDED.desired_release_sequence,
			desired_feed_sequence = EXCLUDED.desired_feed_sequence,
			applied_release_id = EXCLUDED.applied_release_id,
			applied_release_sequence = EXCLUDED.applied_release_sequence,
			applied_feed_sequence = EXCLUDED.applied_feed_sequence,
			applied_channel = EXCLUDED.applied_channel,
			applied_feed_digest = EXCLUDED.applied_feed_digest,
			rollback_to_release_id = EXCLUDED.rollback_to_release_id,
			rollback_to_sequence = EXCLUDED.rollback_to_sequence,
			manifest_digest = EXCLUDED.manifest_digest,
			status = EXCLUDED.status,
			revision_ref = EXCLUDED.revision_ref,
			settings_hash = EXCLUDED.settings_hash,
			personal_baseline_version_id = EXCLUDED.personal_baseline_version_id,
			personal_baseline_effective_settings_digest = EXCLUDED.personal_baseline_effective_settings_digest,
			personal_baseline_settings = EXCLUDED.personal_baseline_settings,
			baseline_override = EXCLUDED.baseline_override,
			baseline_override_digest = EXCLUDED.baseline_override_digest,
			error_code = NULL,
			updated_at = NOW(),
			applied_at = NOW()
		RETURNING desired_release_id, desired_release_sequence, desired_feed_sequence,
		          applied_release_id, applied_release_sequence, applied_feed_sequence,
		          applied_channel, applied_feed_digest, environment,
		          rollback_to_release_id, rollback_to_sequence,
		          manifest_digest, status, revision_ref, settings_hash, applied_at,
		          personal_baseline_version_id,
		          personal_baseline_effective_settings_digest,
		          personal_baseline_settings, baseline_override,
		          baseline_override_digest
	`;
	return {
		...evidenceFromReceipt(input.agentId, receipt[0]),
		idempotent: false,
		repaired: false,
	};
}

function assertRetryMatchesReceipt(
	current: ReceiptRow,
	command: AgentReleaseApplyCommand,
): void {
	const identity = personalBaselineIdentityFromReceipt(current);
	if (
		identity.baselineVersionId !== command.baselineVersionId ||
		identity.effectiveSettingsDigest !== command.effectiveSettingsDigest
	) {
		throw releaseError(
			"agent_release_personal_baseline_retry_identity_mismatch",
			409,
			"Agent release retry must use the originally persisted baseline identity",
		);
	}
	const persistedOverride = baselineOverrideFromReceipt(
		current,
		identity,
	).baselineOverride;
	if (
		(persistedOverride === undefined) !==
			(command.baselineOverride === undefined) ||
		(persistedOverride !== undefined &&
			command.baselineOverride !== undefined &&
			canonicalize(persistedOverride) !==
				canonicalize(command.baselineOverride))
	) {
		throw releaseError(
			"agent_release_baseline_override_retry_mismatch",
			409,
			"Agent release retry must use the originally persisted break-glass provenance",
		);
	}
}

async function applyManagedSettings(
	tx: DbClient,
	organizationId: string,
	agentId: string,
	settings: ManagedSettings,
): Promise<AgentSettingsRow> {
	const updatedRows = await tx<AgentSettingsRow>`
		UPDATE agents SET
			identity_md = CASE
				WHEN ${hasOwn(settings, "identityMd")} THEN ${settings.identityMd ?? ""}
				ELSE identity_md
			END,
			soul_md = CASE
				WHEN ${hasOwn(settings, "soulMd")} THEN ${settings.soulMd ?? ""}
				ELSE soul_md
			END,
			user_md = CASE
				WHEN ${hasOwn(settings, "userMd")} THEN ${settings.userMd ?? ""}
				ELSE user_md
			END,
			model_selection = CASE
				WHEN ${hasOwn(settings, "modelSelection")}
					THEN ${tx.json(settings.modelSelection ?? {})}
				ELSE model_selection
			END,
			tools_config = CASE
				WHEN ${hasOwn(settings, "toolsConfig")}
					THEN ${tx.json(settings.toolsConfig ?? {})}
				ELSE tools_config
			END,
			updated_at = NOW()
		WHERE organization_id = ${organizationId}
		  AND id = ${agentId}
		RETURNING owner_user_id, identity_md, soul_md, user_md,
		          model_selection, tools_config
	`;
	const updated = updatedRows[0];
	if (!updated) {
		throw releaseError(
			"agent_release_agent_not_found",
			404,
			"Agent release target disappeared during apply",
		);
	}
	return updated;
}

async function applyCommandSettings(
	tx: DbClient,
	input: {
		organizationId: string;
		agentId: string;
		command: AgentReleaseApplyCommand;
	},
): Promise<AgentSettingsRow> {
	if (!input.command.settings) {
		return applyManagedSettings(
			tx,
			input.organizationId,
			input.agentId,
			input.command.signedManifest.managedSettings,
		);
	}
	await replaceAgentSettings(
		tx,
		input.organizationId,
		input.agentId,
		input.command.settings as Omit<AgentSettings, "updatedAt">,
	);
	await syncProvisioningGrantsInTransaction(
		tx,
		input.organizationId,
		input.agentId,
		input.command.settings as Omit<AgentSettings, "updatedAt">,
	);
	const rows = await tx<AgentSettingsRow>`
		SELECT owner_user_id, identity_md, soul_md, user_md, model,
		       model_selection, provider_model_preferences, network_config,
		       egress_config, nix_config, mcp_servers, skills_config, tools_config,
		       plugins_config, installed_providers, verbose_logging,
		       pre_approved_tools, guardrails
		FROM agents
		WHERE organization_id = ${input.organizationId} AND id = ${input.agentId}
	`;
	if (!rows[0]) {
		throw releaseError(
			"agent_release_agent_not_found",
			404,
			"Agent release target disappeared during apply",
		);
	}
	return rows[0];
}

async function writeFeedCursor(
	tx: DbClient,
	input: {
		organizationId: string;
		agentId: string;
		command: AgentReleaseApplyCommand;
		feedDigest: string;
	},
	cursor: FeedCursorRow | null,
): Promise<void> {
	const feed = input.command.signedFeed;
	if (
		cursor &&
		cursor.highest_feed_sequence === feed.feedSequence &&
		cursor.highest_feed_digest === input.feedDigest
	) {
		return;
	}
	await tx`
		INSERT INTO agent_release_feed_cursors (
			organization_id, agent_id, environment, channel,
			highest_feed_sequence, highest_feed_digest, created_at, updated_at
		) VALUES (
			${input.organizationId}, ${input.agentId}, ${feed.environment}, ${feed.channel},
			${feed.feedSequence}, ${input.feedDigest}, NOW(), NOW()
		)
		ON CONFLICT (organization_id, agent_id, environment, channel) DO UPDATE SET
			highest_feed_sequence = EXCLUDED.highest_feed_sequence,
			highest_feed_digest = EXCLUDED.highest_feed_digest,
			updated_at = NOW()
	`;
}

interface AgentSettingsRow {
	owner_user_id: string | null;
	identity_md: string | null;
	soul_md: string | null;
	user_md: string | null;
	model_selection: unknown;
	tools_config: unknown;
	model?: string | null;
	provider_model_preferences?: unknown;
	network_config?: unknown;
	egress_config?: unknown;
	nix_config?: unknown;
	mcp_servers?: unknown;
	skills_config?: unknown;
	plugins_config?: unknown;
	installed_providers?: unknown;
	verbose_logging?: boolean;
	pre_approved_tools?: unknown;
	guardrails?: unknown;
}

interface ReceiptRow {
	desired_release_id?: string;
	desired_release_sequence?: number;
	desired_feed_sequence?: number;
	applied_release_id: string;
	applied_release_sequence: number;
	applied_feed_sequence: number;
	applied_channel: "candidate" | "stable";
	applied_feed_digest: string;
	rollback_to_release_id: string | null;
	rollback_to_sequence: number | null;
	environment: AgentReleaseEnvironment;
	manifest_digest: string;
	status: string;
	revision_ref: string;
	settings_hash: string;
	applied_at: Date | string;
	personal_baseline_version_id?: string | null;
	personal_baseline_effective_settings_digest?: string | null;
	personal_baseline_settings?: Record<string, unknown> | null;
	baseline_override?: unknown | null;
	baseline_override_digest?: string | null;
}

type ReceiptWithAgentRow = ReceiptRow & AgentSettingsRow;

interface FeedCursorRow {
	highest_feed_sequence: number;
	highest_feed_digest: string;
}

function evidenceFromReceipt(
	agentId: string,
	row: ReceiptRow,
): AgentReleaseEvidence {
	const personalIdentity = personalBaselineIdentityFromReceipt(row);
	const baselineOverride = baselineOverrideFromReceipt(row, personalIdentity);
	return {
		ok: true,
		agentId,
		releaseId: row.applied_release_id,
		releaseSequence: Number(row.applied_release_sequence),
		feedSequence: Number(row.applied_feed_sequence),
		channel: row.applied_channel,
		feedDigest: row.applied_feed_digest,
		manifestDigest: row.manifest_digest,
		status:
			personalIdentity.effectiveSettingsDigest !== undefined &&
			!safeDigestEqual(
				personalIdentity.effectiveSettingsDigest,
				row.settings_hash,
			)
				? "drifted"
				: "applied",
		revisionRef: row.revision_ref,
		settingsHash: row.settings_hash,
		...personalIdentity,
		...baselineOverride,
		appliedAt:
			row.applied_at instanceof Date
				? row.applied_at.toISOString()
				: new Date(row.applied_at).toISOString(),
	};
}

function baselineOverrideFromReceipt(
	row: ReceiptRow,
	personalIdentity: {
		baselineVersionId?: string;
		effectiveSettingsDigest?: string;
	},
): { baselineOverride?: BaselineOverrideProvenance } {
	if (row.baseline_override == null && row.baseline_override_digest == null)
		return {};
	try {
		if (
			row.baseline_override == null ||
			typeof row.baseline_override_digest !== "string" ||
			!SHA256_PATTERN.test(row.baseline_override_digest) ||
			!safeDigestEqual(
				digestValue(row.baseline_override),
				row.baseline_override_digest,
			)
		) {
			throw new Error("receipt provenance digest mismatch");
		}
		const baselineOverride = parseBaselineOverride(row.baseline_override);
		if (
			baselineOverride.overrideBaselineVersionId !==
				personalIdentity.baselineVersionId ||
			baselineOverride.overrideEffectiveSettingsDigest !==
				personalIdentity.effectiveSettingsDigest
		) {
			throw new Error("receipt identity mismatch");
		}
		return { baselineOverride };
	} catch {
		throw releaseError(
			"agent_release_baseline_override_receipt_invalid",
			409,
			"Break-glass baseline override receipt provenance is invalid",
		);
	}
}

function personalBaselineIdentityFromReceipt(row: ReceiptRow): {
	baselineVersionId?: string;
	effectiveSettingsDigest?: string;
} {
	const hasVersionId = row.personal_baseline_version_id != null;
	const hasEffectiveDigest =
		row.personal_baseline_effective_settings_digest != null;
	const hasSettings = row.personal_baseline_settings != null;
	if (!hasVersionId && !hasEffectiveDigest && !hasSettings) return {};
	if (
		!hasVersionId ||
		!hasEffectiveDigest ||
		!hasSettings ||
		!PERSONAL_BASELINE_VERSION_PATTERN.test(
			row.personal_baseline_version_id as string,
		) ||
		!SHA256_PATTERN.test(
			row.personal_baseline_effective_settings_digest as string,
		)
	) {
		throw releaseError(
			"agent_release_personal_baseline_receipt_identity_invalid",
			409,
			"Personal baseline receipt identity must be present as a closed pair",
		);
	}
	return {
		baselineVersionId: row.personal_baseline_version_id as string,
		effectiveSettingsDigest:
			row.personal_baseline_effective_settings_digest as string,
	};
}

function settingsHashFromAgent(
	agent: AgentSettingsRow,
	personalSettings?: Record<string, unknown> | null,
): string {
	if (personalSettings) {
		const live = { ...personalSettings };
		const values: Record<string, unknown> = {
			identityMd: agent.identity_md ?? "",
			soulMd: agent.soul_md ?? "",
			userMd: agent.user_md ?? "",
			mcpServers: agent.mcp_servers ?? {},
			skillsConfig: agent.skills_config ?? { skills: [] },
			preApprovedTools: agent.pre_approved_tools ?? [],
			modelSelection: agent.model_selection ?? {},
			providerModelPreferences: agent.provider_model_preferences ?? {},
			networkConfig: agent.network_config ?? {},
			egressConfig: agent.egress_config ?? {},
			nixConfig: agent.nix_config ?? {},
			toolsConfig: agent.tools_config ?? {},
			pluginsConfig: agent.plugins_config ?? {},
			guardrails: agent.guardrails ?? [],
			installedProviders: agent.installed_providers ?? [],
		};
		for (const [key, value] of Object.entries(values)) {
			if (hasOwn(personalSettings, key)) live[key] = value;
		}
		return digestValue(live);
	}
	return digestValue({
		identityMd: agent.identity_md ?? "",
		soulMd: agent.soul_md ?? "",
		userMd: agent.user_md ?? "",
		modelSelection: agent.model_selection ?? {},
		toolsConfig: agent.tools_config ?? {},
	});
}

function parseApplyCommand(value: unknown): AgentReleaseApplyCommand {
	if (!isRecord(value))
		throw invalidRequest("Agent release command must be an object");
	assertExactKeys(
		value,
		[
			"signedManifest",
			"signedFeed",
			"assignment",
			"settings",
			"baselineVersionId",
			"baselineVersion",
			"effectiveSettingsDigest",
			"baselineOverride",
			"assignmentRevision",
			"claimToken",
			"stepOrdinal",
			"stepLeaseToken",
			"expectedCurrentReleaseSequence",
			"commandDigest",
		],
		"command",
	);
	const signedManifest = parseManifest(value.signedManifest);
	const signedFeed = parseFeed(value.signedFeed);
	const assignment = parseAssignment(value.assignment);
	const personalKeys = [
		"settings",
		"baselineVersionId",
		"effectiveSettingsDigest",
	] as const;
	const presentPersonalKeys = personalKeys.filter((key) => hasOwn(value, key));
	if (
		presentPersonalKeys.length !== 0 &&
		presentPersonalKeys.length !== personalKeys.length
	) {
		throw invalidRequest(
			"Personal baseline settings and identity must be provided together",
		);
	}
	let settings: Record<string, unknown> | undefined;
	if (presentPersonalKeys.length > 0) {
		settings = requireRecord(value.settings, "personal baseline settings");
		assertExactKeys(
			settings,
			PERSONAL_BASELINE_SETTING_KEYS,
			"personal baseline settings",
		);
		if (
			typeof value.baselineVersionId !== "string" ||
			!PERSONAL_BASELINE_VERSION_PATTERN.test(value.baselineVersionId) ||
			typeof value.effectiveSettingsDigest !== "string" ||
			!SHA256_PATTERN.test(value.effectiveSettingsDigest)
		) {
			throw invalidRequest("Personal baseline identity is invalid");
		}
	}
	const baselineOverride = hasOwn(value, "baselineOverride")
		? parseBaselineOverride(value.baselineOverride)
		: undefined;
	if (
		baselineOverride !== undefined &&
		(!hasOwn(value, "baselineVersion") ||
			!isPositiveSafeInteger(value.baselineVersion))
	) {
		throw invalidRequest(
			"Break-glass baseline override requires a positive baselineVersion",
		);
	}
	if (baselineOverride === undefined && hasOwn(value, "baselineVersion")) {
		throw invalidRequest(
			"baselineVersion is only accepted with a break-glass baseline override",
		);
	}
	const currentAttemptKeys = [
		"assignmentRevision",
		"claimToken",
		"stepOrdinal",
		"stepLeaseToken",
	] as const;
	const presentAttemptKeys = currentAttemptKeys.filter((key) =>
		hasOwn(value, key),
	);
	if (
		presentAttemptKeys.length !== 0 &&
		presentAttemptKeys.length !== currentAttemptKeys.length
	) {
		throw invalidRequest(
			"Agent release apply attempt subjects must be provided together",
		);
	}
	if (presentAttemptKeys.length > 0) {
		for (const key of [
			"assignmentRevision",
			"claimToken",
			"stepLeaseToken",
		] as const) {
			if (typeof value[key] !== "string" || !isUuid(value[key])) {
				throw invalidRequest(`Agent release ${key} must be a UUID`);
			}
		}
		if (
			!Number.isSafeInteger(value.stepOrdinal) ||
			Number(value.stepOrdinal) < 0
		) {
			throw invalidRequest(
				"Agent release stepOrdinal must be a nonnegative safe integer",
			);
		}
	}
	const expectedCurrentReleaseSequence = value.expectedCurrentReleaseSequence;
	if (
		expectedCurrentReleaseSequence !== null &&
		!isPositiveSafeInteger(expectedCurrentReleaseSequence)
	) {
		throw invalidRequest(
			"Expected current release sequence must be null or a positive safe integer",
		);
	}
	if (
		typeof value.commandDigest !== "string" ||
		!SHA256_PATTERN.test(value.commandDigest)
	) {
		throw invalidRequest(
			"Agent release command digest must be a lowercase SHA-256 digest",
		);
	}
	return {
		signedManifest,
		signedFeed,
		assignment,
		...(presentAttemptKeys.length > 0
			? {
					assignmentRevision: value.assignmentRevision as string,
					claimToken: value.claimToken as string,
					stepOrdinal: value.stepOrdinal as number,
					stepLeaseToken: value.stepLeaseToken as string,
				}
			: {}),
		...(settings
			? {
					settings,
					baselineVersionId: value.baselineVersionId as string,
					effectiveSettingsDigest: value.effectiveSettingsDigest as string,
				}
			: {}),
		...(baselineOverride
			? {
					baselineVersion: value.baselineVersion as number,
					baselineOverride,
				}
			: {}),
		expectedCurrentReleaseSequence,
		commandDigest: value.commandDigest,
	};
}

function parseManifest(value: unknown): SignedManifest {
	if (!isRecord(value))
		throw invalidRequest("Signed agent release manifest must be an object");
	assertExactKeys(
		value,
		[
			"releaseId",
			"releaseSequence",
			"environment",
			"releaseKind",
			"createdAt",
			"managedSettings",
			"controlPlanePolicy",
			"rollbackToSequence",
			"rollbackTo",
			"signing",
		],
		"manifest",
	);
	if (typeof value.releaseId !== "string" || value.releaseId.trim() === "") {
		throw invalidRequest("Agent release id is required");
	}
	if (!isPositiveSafeInteger(value.releaseSequence)) {
		throw invalidRequest(
			"Agent release sequence must be a positive safe integer",
		);
	}
	const environment = parseEnvironment(value.environment, "manifest");
	if (
		value.releaseKind !== "capability_activation" &&
		value.releaseKind !== "runtime_carrier"
	) {
		throw invalidRequest("Agent release kind is invalid");
	}
	if (
		typeof value.createdAt !== "string" ||
		!isStrictRfc3339(value.createdAt)
	) {
		throw invalidRequest("Agent release createdAt is invalid");
	}
	const managedSettings = parseManagedSettings(value.managedSettings);
	const controlPlanePolicy = hasOwn(value, "controlPlanePolicy")
		? parseControlPlanePolicy(value.controlPlanePolicy)
		: undefined;
	const hasRollbackTo = hasOwn(value, "rollbackTo");
	const hasRollbackToSequence = hasOwn(value, "rollbackToSequence");
	if (hasRollbackTo !== hasRollbackToSequence) {
		throw invalidRollback(
			"Agent release manifest rollback target id and sequence must be provided together",
		);
	}
	if (
		hasRollbackToSequence &&
		(!isPositiveSafeInteger(value.rollbackToSequence) ||
			value.rollbackToSequence >= value.releaseSequence)
	) {
		throw invalidRollback(
			"Agent release manifest rollback target sequence must be older than its source",
		);
	}
	if (
		hasRollbackTo &&
		(typeof value.rollbackTo !== "string" || value.rollbackTo.trim() === "")
	) {
		throw invalidRollback(
			"Agent release manifest rollback target id is invalid",
		);
	}
	const signing = parseSigningMetadata(value.signing, "manifest");
	return {
		releaseId: value.releaseId,
		releaseSequence: value.releaseSequence,
		environment,
		releaseKind: value.releaseKind,
		createdAt: value.createdAt,
		managedSettings,
		...(controlPlanePolicy ? { controlPlanePolicy } : {}),
		...(hasRollbackToSequence
			? { rollbackToSequence: value.rollbackToSequence as number }
			: {}),
		...(hasRollbackTo ? { rollbackTo: value.rollbackTo as string } : {}),
		signing,
	};
}

function parseFeed(value: unknown): SignedFeed {
	if (!isRecord(value))
		throw invalidRequest("Signed agent release feed must be an object");
	assertExactKeys(
		value,
		[
			"feedVersion",
			"feedSequence",
			"environment",
			"channel",
			"generatedAt",
			"publications",
			"activationMode",
			"rollout",
			"feedSigning",
		],
		"feed",
	);
	if (value.feedVersion !== 1)
		throw invalidRequest("Agent release feed version is unsupported");
	if (!isPositiveSafeInteger(value.feedSequence)) {
		throw invalidRequest(
			"Agent release feed sequence must be a positive safe integer",
		);
	}
	const environment = parseEnvironment(value.environment, "feed");
	if (value.channel !== "candidate" && value.channel !== "stable") {
		throw invalidRequest("Agent release feed channel is invalid");
	}
	if (
		typeof value.generatedAt !== "string" ||
		!isStrictRfc3339(value.generatedAt)
	) {
		throw invalidRequest("Agent release feed generatedAt is invalid");
	}
	if (!Array.isArray(value.publications) || value.publications.length === 0) {
		throw invalidRequest("Agent release feed must include a publication");
	}
	const publications = value.publications.map(parsePublication);
	const hasActivationMode = hasOwn(value, "activationMode");
	const hasRollout = hasOwn(value, "rollout");
	if (hasActivationMode !== hasRollout) {
		throw invalidRequest(
			"Agent release feed activationMode and rollout must be provided together",
		);
	}
	let activationMode: SignedFeed["activationMode"];
	let rollout: SignedFeed["rollout"];
	if (hasActivationMode) {
		if (
			value.activationMode !== "per_agent" &&
			value.activationMode !== "shared_carrier"
		) {
			throw invalidRequest("Agent release feed activation mode is invalid");
		}
		activationMode = value.activationMode;
		rollout = parseSignedRollout(value.rollout);
	}
	const feedSigning = parseSigningMetadata(value.feedSigning, "feed");
	return {
		feedVersion: 1,
		feedSequence: value.feedSequence,
		environment,
		channel: value.channel,
		generatedAt: value.generatedAt,
		publications,
		...(activationMode
			? {
					activationMode,
					rollout: rollout as NonNullable<SignedFeed["rollout"]>,
				}
			: {}),
		feedSigning,
	};
}

function parsePublication(value: unknown): FeedPublication {
	if (!isRecord(value))
		throw invalidRequest("Agent release publication must be an object");
	assertExactKeys(
		value,
		[
			"releaseId",
			"releaseSequence",
			"manifestDigest",
			"manifest",
			"publicationKind",
			"fromReleaseSequence",
			"toReleaseSequence",
			"toReleaseId",
			"allowDowngrade",
			"reason",
			"actor",
			"expiresAt",
		],
		"publication",
	);
	if (typeof value.releaseId !== "string" || value.releaseId.trim() === "") {
		throw invalidRequest("Agent release publication id is required");
	}
	if (!isPositiveSafeInteger(value.releaseSequence)) {
		throw invalidRequest("Agent release publication sequence is invalid");
	}
	if (
		typeof value.manifestDigest !== "string" ||
		!SHA256_PATTERN.test(value.manifestDigest)
	) {
		throw invalidRequest(
			"Agent release publication manifest digest is invalid",
		);
	}
	if (
		value.publicationKind !== undefined &&
		value.publicationKind !== "release" &&
		value.publicationKind !== "rollback" &&
		value.publicationKind !== "pause"
	) {
		throw invalidRequest("Agent release publication kind is invalid");
	}
	const rollbackFields = [
		"fromReleaseSequence",
		"toReleaseSequence",
		"toReleaseId",
		"allowDowngrade",
		"reason",
		"actor",
		"expiresAt",
	] as const;
	if (value.publicationKind !== "rollback") {
		if (rollbackFields.some((key) => hasOwn(value, key))) {
			throw invalidRollback(
				"Ordinary agent release publication cannot include rollback-only fields",
			);
		}
		if (value.publicationKind === "pause") {
			throw invalidRequest(
				"Paused agent release publications cannot be applied",
			);
		}
	} else {
		if (!isPositiveSafeInteger(value.fromReleaseSequence)) {
			throw invalidRollback("Signed rollback requires fromReleaseSequence");
		}
		if (!isPositiveSafeInteger(value.toReleaseSequence)) {
			throw invalidRollback("Signed rollback requires toReleaseSequence");
		}
		if (
			typeof value.toReleaseId !== "string" ||
			value.toReleaseId.trim() === ""
		) {
			throw invalidRollback("Signed rollback requires nonempty toReleaseId");
		}
		if (value.allowDowngrade !== true) {
			throw invalidRollback("Signed rollback requires allowDowngrade=true");
		}
		for (const key of ["reason", "actor"] as const) {
			if (typeof value[key] !== "string" || value[key].trim() === "") {
				throw invalidRollback(`Signed rollback requires nonempty ${key}`);
			}
		}
		if (
			typeof value.expiresAt !== "string" ||
			!isStrictRfc3339(value.expiresAt)
		) {
			throw invalidRollback("Signed rollback requires a valid expiresAt");
		}
	}
	return {
		releaseId: value.releaseId,
		releaseSequence: value.releaseSequence,
		manifestDigest: value.manifestDigest,
		manifest: parseManifest(value.manifest),
		...(value.publicationKind
			? { publicationKind: value.publicationKind }
			: {}),
		...(value.publicationKind === "rollback"
			? {
					fromReleaseSequence: value.fromReleaseSequence as number,
					toReleaseSequence: value.toReleaseSequence as number,
					toReleaseId: value.toReleaseId as string,
					allowDowngrade: true as const,
					reason: value.reason as string,
					actor: value.actor as string,
					expiresAt: value.expiresAt as string,
				}
			: {}),
	};
}

function parseAssignment(value: unknown): ReleaseAssignment {
	if (!isRecord(value))
		throw invalidRequest("Agent release assignment must be an object");
	assertExactKeys(
		value,
		["environment", "targetId", "toolboxUserId", "agentId"],
		"assignment",
	);
	const environment = parseEnvironment(value.environment, "assignment");
	for (const key of ["targetId", "toolboxUserId", "agentId"] as const) {
		if (typeof value[key] !== "string" || value[key].trim() === "") {
			throw invalidRequest(`Agent release assignment ${key} is required`);
		}
	}
	return {
		environment,
		targetId: value.targetId as string,
		toolboxUserId: value.toolboxUserId as string,
		agentId: value.agentId as string,
	};
}

function parseManagedSettings(value: unknown): ManagedSettings {
	if (!isRecord(value)) {
		throw invalidManagedSettings(
			"Agent release managed settings must be an object",
		);
	}
	for (const key of Object.keys(value)) {
		if (!(MANAGED_SETTING_KEYS as readonly string[]).includes(key)) {
			throw invalidManagedSettings(
				`Agent release refused unmanaged setting key: ${key}`,
			);
		}
	}
	for (const key of ["identityMd", "soulMd", "userMd"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw invalidManagedSettings(
				`Agent release managed setting ${key} must be a string`,
			);
		}
	}
	const result: ManagedSettings = {};
	if (hasOwn(value, "identityMd"))
		result.identityMd = value.identityMd as string;
	if (hasOwn(value, "soulMd")) result.soulMd = value.soulMd as string;
	if (hasOwn(value, "userMd")) result.userMd = value.userMd as string;
	if (hasOwn(value, "modelSelection")) {
		result.modelSelection = parseModelSelection(value.modelSelection);
	}
	if (hasOwn(value, "toolsConfig"))
		result.toolsConfig = parseToolsConfig(value.toolsConfig);
	return result;
}

function parseModelSelection(value: unknown): ManagedModelSelection {
	if (!isRecord(value)) {
		throw invalidManagedSettings(
			"Agent release modelSelection must be an object",
		);
	}
	assertManagedNestedKeys("modelSelection", value, ["mode", "pinnedModel"]);
	if (value.mode !== "auto" && value.mode !== "pinned") {
		throw invalidManagedSettings(
			"Agent release modelSelection mode must be auto or pinned",
		);
	}
	if (value.mode === "auto") {
		if (hasOwn(value, "pinnedModel")) {
			throw invalidManagedSettings(
				"Agent release auto model selection cannot include pinnedModel",
			);
		}
		return { mode: "auto" };
	}
	if (
		typeof value.pinnedModel !== "string" ||
		value.pinnedModel.trim() === ""
	) {
		throw invalidManagedSettings(
			"Agent release pinned model selection requires pinnedModel",
		);
	}
	return { mode: "pinned", pinnedModel: value.pinnedModel };
}

function parseToolsConfig(value: unknown): ManagedToolsConfig {
	if (!isRecord(value)) {
		throw invalidManagedSettings("Agent release toolsConfig must be an object");
	}
	assertManagedNestedKeys("toolsConfig", value, [
		"allowedTools",
		"deniedTools",
		"strictMode",
		"mcpExposure",
	]);
	const result: ManagedToolsConfig = {};
	for (const key of ["allowedTools", "deniedTools"] as const) {
		if (value[key] !== undefined) {
			if (
				!Array.isArray(value[key]) ||
				!value[key].every((item) => typeof item === "string")
			) {
				throw invalidManagedSettings(
					`Agent release toolsConfig ${key} must be an array of strings`,
				);
			}
			result[key] = [...value[key]];
		}
	}
	if (value.strictMode !== undefined) {
		if (typeof value.strictMode !== "boolean") {
			throw invalidManagedSettings(
				"Agent release toolsConfig strictMode must be a boolean",
			);
		}
		result.strictMode = value.strictMode;
	}
	if (value.mcpExposure !== undefined) {
		if (value.mcpExposure !== "tools" && value.mcpExposure !== "cli") {
			throw invalidManagedSettings(
				"Agent release toolsConfig mcpExposure must be tools or cli",
			);
		}
		result.mcpExposure = value.mcpExposure;
	}
	return result;
}

function parseControlPlanePolicy(value: unknown): ControlPlanePolicy {
	const policy = requireRecord(value, "controlPlanePolicy");
	assertRequiredExactKeys(
		policy,
		[
			"eligibility",
			"rolloutPolicy",
			"requiredCarriers",
			"baseline",
			"capabilities",
			"migrations",
			"rollbackStrategy",
		],
		["runtimeCarrier", "personalAgentBaseline"],
		"controlPlanePolicy",
	);
	const eligibility = requireRecord(policy.eligibility, "eligibility");
	assertRequiredExactKeys(
		eligibility,
		[
			"minimumSourceSequence",
			"maximumSourceSequence",
			"freshInstallAllowed",
			"requiredAppliedCapabilities",
			"requiredIntermediateSequences",
			"cohortAlgorithmVersion",
		],
		[],
		"eligibility",
	);
	for (const key of [
		"minimumSourceSequence",
		"maximumSourceSequence",
	] as const) {
		if (eligibility[key] !== null && !isPositiveSafeInteger(eligibility[key])) {
			throw invalidRequest(`Agent release eligibility ${key} is invalid`);
		}
	}
	if (
		typeof eligibility.freshInstallAllowed !== "boolean" ||
		eligibility.cohortAlgorithmVersion !== "hmac-sha256-toolbox-user-v1"
	) {
		throw invalidRequest("Agent release eligibility is invalid");
	}
	if (
		eligibility.minimumSourceSequence !== null &&
		eligibility.maximumSourceSequence !== null &&
		Number(eligibility.minimumSourceSequence) >
			Number(eligibility.maximumSourceSequence)
	) {
		throw invalidRequest("Agent release eligibility source range is invalid");
	}
	parseStringArray(
		eligibility.requiredAppliedCapabilities,
		"requiredAppliedCapabilities",
	);
	parsePositiveIntegerArray(
		eligibility.requiredIntermediateSequences,
		"requiredIntermediateSequences",
	);

	const rolloutPolicy = requireRecord(policy.rolloutPolicy, "rolloutPolicy");
	assertRequiredExactKeys(
		rolloutPolicy,
		["kind", "stages", "gates"],
		[],
		"rolloutPolicy",
	);
	if (rolloutPolicy.kind !== "standard" && rolloutPolicy.kind !== "critical") {
		throw invalidRequest("Agent release rollout policy kind is invalid");
	}
	parsePercentageArray(rolloutPolicy.stages, "rollout stages");
	const gates = requireRecord(rolloutPolicy.gates, "rollout gates");
	assertRequiredExactKeys(
		gates,
		[
			"minimumCanaries",
			"minimumCanaryObservationMinutes",
			"requiredSmokeNames",
		],
		[],
		"rollout gates",
	);
	if (
		!Number.isSafeInteger(gates.minimumCanaries) ||
		Number(gates.minimumCanaries) < 2 ||
		!Number.isSafeInteger(gates.minimumCanaryObservationMinutes) ||
		Number(gates.minimumCanaryObservationMinutes) < 30 ||
		Number(gates.minimumCanaryObservationMinutes) > 1440
	) {
		throw invalidRequest("Agent release rollout gates are invalid");
	}
	parseStringArray(gates.requiredSmokeNames, "requiredSmokeNames", 1);

	if (
		!Array.isArray(policy.requiredCarriers) ||
		policy.requiredCarriers.length < 1 ||
		policy.requiredCarriers.length > 16
	)
		throw invalidRequest("Agent release required carriers are invalid");
	const carrierKeys = new Set<string>();
	const providedCapabilities = new Set<string>();
	for (const carrierValue of policy.requiredCarriers) {
		const carrier = requireRecord(carrierValue, "required carrier");
		assertRequiredExactKeys(
			carrier,
			["component", "revision", "origin", "provides", "requires"],
			["artifactDigest", "imageDigest"],
			"required carrier",
		);
		if (
			!["toolbox-api", "toolbox-mcp", "lobu-runtime"].includes(
				String(carrier.component),
			) ||
			typeof carrier.revision !== "string" ||
			carrier.revision.trim() === "" ||
			!isCanonicalHttpsOrigin(carrier.origin)
		)
			throw invalidRequest("Agent release required carrier is invalid");
		parseStringArray(carrier.provides, "carrier provides", 1);
		parseStringArray(carrier.requires, "carrier requires");
		const carrierKey = `${String(carrier.component)}:${String(carrier.revision)}`;
		if (carrierKeys.has(carrierKey)) {
			throw invalidRequest("Agent release required carrier is duplicated");
		}
		carrierKeys.add(carrierKey);
		for (const provided of carrier.provides as string[]) {
			providedCapabilities.add(provided);
			providedCapabilities.add(`${String(carrier.component)}:${provided}`);
		}
		const digests = [carrier.artifactDigest, carrier.imageDigest].filter(
			(item) => item !== undefined,
		);
		if (digests.length !== 1 || !SHA256_PATTERN.test(String(digests[0]))) {
			throw invalidRequest(
				"Agent release carrier must contain exactly one artifact digest",
			);
		}
	}

	if (policy.baseline !== null) {
		const baseline = requireRecord(policy.baseline, "baseline");
		assertRequiredExactKeys(
			baseline,
			["settingsHash", "fullBundleDigest", "patches"],
			[],
			"baseline",
		);
		if (
			!SHA256_PATTERN.test(String(baseline.settingsHash)) ||
			!SHA256_PATTERN.test(String(baseline.fullBundleDigest)) ||
			!Array.isArray(baseline.patches) ||
			baseline.patches.length > 32
		) {
			throw invalidRequest("Agent release baseline is invalid");
		}
		for (const patchValue of baseline.patches) {
			const item = requireRecord(patchValue, "baseline patch");
			assertRequiredExactKeys(
				item,
				["fromSettingsHash", "patchDigest"],
				[],
				"baseline patch",
			);
			if (
				!SHA256_PATTERN.test(String(item.fromSettingsHash)) ||
				!SHA256_PATTERN.test(String(item.patchDigest))
			) {
				throw invalidRequest("Agent release baseline patch is invalid");
			}
		}
	}
	if (hasOwn(policy, "personalAgentBaseline")) {
		parsePersonalAgentBaselineContract(policy.personalAgentBaseline);
	}
	if ((policy.baseline === null) === !hasOwn(policy, "personalAgentBaseline")) {
		throw invalidRequest(
			"Capability policy must contain exactly one managed baseline contract",
		);
	}

	if (
		!Array.isArray(policy.capabilities) ||
		policy.capabilities.length < 1 ||
		policy.capabilities.length > 64
	) {
		throw invalidRequest("Agent release capabilities are invalid");
	}
	const capabilityNames = new Set<string>();
	const requiredCapabilities: string[] = [];
	for (const capabilityValue of policy.capabilities) {
		const capability = requireRecord(capabilityValue, "capability");
		assertRequiredExactKeys(
			capability,
			["name", "requires", "smokes"],
			[],
			"capability",
		);
		if (
			typeof capability.name !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(capability.name)
		) {
			throw invalidRequest("Agent release capability name is invalid");
		}
		if (capabilityNames.has(capability.name)) {
			throw invalidRequest("Agent release capability is duplicated");
		}
		capabilityNames.add(capability.name);
		requiredCapabilities.push(
			...parseStringArray(capability.requires, "capability requires", 1),
		);
		parseStringArray(capability.smokes, "capability smokes", 1);
	}
	for (const carrierValue of policy.requiredCarriers) {
		const carrier = carrierValue as Record<string, unknown>;
		requiredCapabilities.push(...(carrier.requires as string[]));
	}
	if (
		requiredCapabilities.some((required) => !providedCapabilities.has(required))
	) {
		throw invalidRequest(
			"Agent release capability dependency closure is incomplete",
		);
	}

	const migrations = requireRecord(policy.migrations, "migrations");
	assertRequiredExactKeys(
		migrations,
		["required", "backwardCompatible"],
		[],
		"migrations",
	);
	parseStringArray(migrations.required, "migrations required");
	if (typeof migrations.backwardCompatible !== "boolean")
		throw invalidRequest("Agent release migrations are invalid");
	const rollback = requireRecord(policy.rollbackStrategy, "rollbackStrategy");
	assertRequiredExactKeys(
		rollback,
		["kind", "backwardCompatible", "boundedDriftMinutes"],
		[],
		"rollbackStrategy",
	);
	if (
		rollback.kind !== "forward_compatible_managed_settings" ||
		rollback.backwardCompatible !== true ||
		!Number.isSafeInteger(rollback.boundedDriftMinutes) ||
		Number(rollback.boundedDriftMinutes) < 1 ||
		Number(rollback.boundedDriftMinutes) > 1440
	)
		throw invalidRequest("Agent release rollback strategy is invalid");
	if (hasOwn(policy, "runtimeCarrier"))
		parseRuntimeCarrierPolicy(policy.runtimeCarrier);
	return policy as unknown as ControlPlanePolicy;
}

function parsePersonalAgentBaselineContract(value: unknown): void {
	const baseline = requireRecord(value, "personalAgentBaseline");
	assertRequiredExactKeys(
		baseline,
		[
			"baselineVersionId",
			"baselineVersion",
			"templateKey",
			"materializationVersion",
			"sourceRepository",
			"sourceRevision",
			"sourcePath",
			"sourceDigest",
			"effectiveSettingsDigest",
			"componentDigests",
		],
		[],
		"personalAgentBaseline",
	);
	if (
		typeof baseline.baselineVersionId !== "string" ||
		!PERSONAL_BASELINE_VERSION_PATTERN.test(baseline.baselineVersionId) ||
		!isPositiveSafeInteger(baseline.baselineVersion) ||
		baseline.templateKey !== "pm-marketing-user-agent" ||
		baseline.materializationVersion !== 1 ||
		baseline.sourceRepository !== "shifu-tw/shifu-toolbox" ||
		typeof baseline.sourceRevision !== "string" ||
		!/^[0-9a-f]{40}$/.test(baseline.sourceRevision) ||
		baseline.sourcePath !==
			"api/src/modules/agent-workbench/agent-baselines/pm-marketing-user-agent/baseline.json" ||
		typeof baseline.sourceDigest !== "string" ||
		!SHA256_PATTERN.test(baseline.sourceDigest) ||
		typeof baseline.effectiveSettingsDigest !== "string" ||
		!SHA256_PATTERN.test(baseline.effectiveSettingsDigest)
	) {
		throw invalidRequest("Agent release personal baseline is invalid");
	}
	const components = requireRecord(
		baseline.componentDigests,
		"personalAgentBaseline componentDigests",
	);
	assertRequiredExactKeys(
		components,
		["instructions", "skills", "mcp", "toolPolicy", "runtime"],
		[],
		"personalAgentBaseline componentDigests",
	);
	if (
		Object.values(components).some(
			(value) => typeof value !== "string" || !SHA256_PATTERN.test(value),
		)
	) {
		throw invalidRequest(
			"Agent release personal baseline component digest is invalid",
		);
	}
}

function parseBaselineOverride(value: unknown): BaselineOverrideProvenance {
	const override = requireRecord(value, "baselineOverride");
	assertRequiredExactKeys(
		override,
		[
			"kind",
			"recordId",
			"incidentReference",
			"operatorUserId",
			"reason",
			"approvedAt",
			"expiresAt",
			"anchoredReleaseId",
			"anchoredReleaseSequence",
			"anchoredFeedSequence",
			"anchoredFeedDigest",
			"anchoredManifestDigest",
			"anchoredBaselineVersionId",
			"anchoredBaselineVersion",
			"anchoredEffectiveSettingsDigest",
			"overrideBaselineVersionId",
			"overrideBaselineVersion",
			"overrideEffectiveSettingsDigest",
		],
		[],
		"baselineOverride",
	);
	if (
		override.kind !== "break_glass" ||
		typeof override.recordId !== "string" ||
		!isUuid(override.recordId) ||
		typeof override.operatorUserId !== "string" ||
		!isCanonicalNonemptyString(override.operatorUserId, 200) ||
		!isCanonicalNonemptyString(override.incidentReference, 500) ||
		!isCanonicalNonemptyString(override.reason, 2000) ||
		!isCanonicalNonemptyString(override.anchoredReleaseId, 200) ||
		!isCanonicalTimestamp(override.approvedAt) ||
		!isCanonicalTimestamp(override.expiresAt) ||
		new Date(override.approvedAt as string).getTime() >=
			new Date(override.expiresAt as string).getTime() ||
		new Date(override.expiresAt as string).getTime() >
			new Date(override.approvedAt as string).getTime() + 60 * 60 * 1000 ||
		!isPositiveSafeInteger(override.anchoredReleaseSequence) ||
		!isPositiveSafeInteger(override.anchoredFeedSequence) ||
		typeof override.anchoredFeedDigest !== "string" ||
		!SHA256_PATTERN.test(override.anchoredFeedDigest) ||
		typeof override.anchoredManifestDigest !== "string" ||
		!SHA256_PATTERN.test(override.anchoredManifestDigest) ||
		typeof override.anchoredBaselineVersionId !== "string" ||
		!PERSONAL_BASELINE_VERSION_PATTERN.test(
			override.anchoredBaselineVersionId,
		) ||
		!isPositiveSafeInteger(override.anchoredBaselineVersion) ||
		typeof override.anchoredEffectiveSettingsDigest !== "string" ||
		!SHA256_PATTERN.test(override.anchoredEffectiveSettingsDigest) ||
		typeof override.overrideBaselineVersionId !== "string" ||
		!PERSONAL_BASELINE_VERSION_PATTERN.test(
			override.overrideBaselineVersionId,
		) ||
		!isPositiveSafeInteger(override.overrideBaselineVersion) ||
		typeof override.overrideEffectiveSettingsDigest !== "string" ||
		!SHA256_PATTERN.test(override.overrideEffectiveSettingsDigest)
	) {
		throw invalidRequest("Break-glass baseline override provenance is invalid");
	}
	return override as unknown as BaselineOverrideProvenance;
}

function isCanonicalNonemptyString(value: unknown, maxLength: number): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value.trim() === value
	);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !isStrictRfc3339(value)) return false;
	const timestamp = new Date(value);
	return (
		!Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value
	);
}

function parseRuntimeCarrierPolicy(value: unknown): void {
	const runtime = requireRecord(value, "runtimeCarrier");
	assertRequiredExactKeys(
		runtime,
		[
			"backwardCompatible",
			"backwardCompatibilitySmokes",
			"boundedDriftMinutes",
			"requiredOperationalEvidence",
			"previousStable",
			"queueConsumer",
			"databaseConsumer",
		],
		[],
		"runtimeCarrier",
	);
	if (
		runtime.backwardCompatible !== true ||
		!Number.isSafeInteger(runtime.boundedDriftMinutes) ||
		Number(runtime.boundedDriftMinutes) < 1 ||
		Number(runtime.boundedDriftMinutes) > 1440
	) {
		throw invalidRequest("Agent release runtime carrier policy is invalid");
	}
	parseStringArray(
		runtime.backwardCompatibilitySmokes,
		"backwardCompatibilitySmokes",
		1,
	);
	parseStringArray(
		runtime.requiredOperationalEvidence,
		"requiredOperationalEvidence",
		3,
	);
	const previous = requireRecord(runtime.previousStable, "previousStable");
	assertRequiredExactKeys(
		previous,
		["releaseId", "releaseSequence"],
		[],
		"previousStable",
	);
	if (
		typeof previous.releaseId !== "string" ||
		previous.releaseId.trim() === "" ||
		!isPositiveSafeInteger(previous.releaseSequence)
	)
		throw invalidRequest("Agent release previous stable is invalid");
	for (const key of ["queueConsumer", "databaseConsumer"] as const) {
		const consumer = requireRecord(runtime[key], key);
		assertRequiredExactKeys(
			consumer,
			["identity", "origin", "evidenceName"],
			[],
			key,
		);
		if (
			typeof consumer.identity !== "string" ||
			consumer.identity.trim() === "" ||
			!isCanonicalHttpsOrigin(consumer.origin) ||
			typeof consumer.evidenceName !== "string" ||
			consumer.evidenceName.trim() === ""
		)
			throw invalidRequest(`Agent release ${key} is invalid`);
	}
}

function parseSignedRollout(
	value: unknown,
): NonNullable<SignedFeed["rollout"]> {
	const rollout = requireRecord(value, "signed rollout");
	assertRequiredExactKeys(
		rollout,
		["percentage", "paused", "cohortAlgorithmVersion"],
		[],
		"signed rollout",
	);
	if (
		!Number.isSafeInteger(rollout.percentage) ||
		Number(rollout.percentage) < 0 ||
		Number(rollout.percentage) > 100 ||
		typeof rollout.paused !== "boolean" ||
		rollout.cohortAlgorithmVersion !== "hmac-sha256-toolbox-user-v1"
	) {
		throw invalidRequest("Agent release signed rollout is invalid");
	}
	return rollout as unknown as NonNullable<SignedFeed["rollout"]>;
}

function parseSigningMetadata(
	value: unknown,
	label: "manifest" | "feed",
): SigningMetadata {
	if (!isRecord(value))
		throw invalidRequest(`Agent release ${label} signing metadata is invalid`);
	assertExactKeys(
		value,
		["algorithm", "keyId", "signature"],
		`${label} signing`,
	);
	if (value.algorithm !== "Ed25519") {
		throw invalidRequest(
			`Agent release ${label} signing algorithm must be Ed25519`,
		);
	}
	if (typeof value.keyId !== "string" || value.keyId.trim() === "") {
		throw invalidRequest(`Agent release ${label} signing key id is required`);
	}
	if (
		typeof value.signature !== "string" ||
		!isCanonicalBase64(value.signature)
	) {
		throw invalidRequest(
			`Agent release ${label} signature must be canonical base64`,
		);
	}
	return {
		algorithm: "Ed25519",
		keyId: value.keyId,
		signature: value.signature,
	};
}

function validateApplyEnvelope(
	agentId: string,
	command: AgentReleaseApplyCommand,
	expectedEnvironment: AgentReleaseEnvironment,
): void {
	if (command.assignment.agentId !== agentId) {
		throw releaseError(
			"agent_release_assignment_scope_mismatch",
			400,
			"Agent release assignment does not match path, manifest, and feed scope",
		);
	}
	if (
		command.assignment.environment !== expectedEnvironment ||
		command.signedManifest.environment !== expectedEnvironment ||
		command.signedFeed.environment !== expectedEnvironment
	) {
		throw releaseError(
			"agent_release_environment_mismatch",
			400,
			"Agent release manifest, feed, and assignment must match the runtime environment",
		);
	}
}

function isCurrentApplyCommand(
	command: AgentReleaseApplyCommand,
): command is AgentReleaseApplyCommand & {
	assignmentRevision: string;
	claimToken: string;
	stepOrdinal: number;
	stepLeaseToken: string;
} {
	return command.assignmentRevision !== undefined;
}

function validateCurrentContract(command: AgentReleaseApplyCommand): void {
	const current = isCurrentApplyCommand(command);
	const manifestPolicy = command.signedManifest.controlPlanePolicy;
	const activationMode = command.signedFeed.activationMode;
	const rollout = command.signedFeed.rollout;
	if (
		!current &&
		manifestPolicy === undefined &&
		activationMode === undefined &&
		rollout === undefined
	) {
		return;
	}
	if (
		!current ||
		manifestPolicy === undefined ||
		activationMode === undefined ||
		rollout === undefined
	) {
		throw invalidRequest(
			"Current agent release command requires policy, feed activation, and apply attempt subjects",
		);
	}
	if (!isUuid(command.assignment.targetId)) {
		throw invalidRequest("Current agent release targetId must be a UUID");
	}
	if (rollout.paused) {
		throw invalidRequest("Paused agent release feeds cannot be applied");
	}
	if (command.signedFeed.publications.length !== 1) {
		throw invalidRequest(
			"Current agent release feed must contain exactly one publication",
		);
	}
	if (
		command.signedManifest.releaseKind !== "capability_activation" ||
		activationMode !== "per_agent"
	) {
		throw invalidRequest(
			"Managed settings only accept per-agent capability activation releases",
		);
	}
	if (
		manifestPolicy.baseline === null &&
		manifestPolicy.personalAgentBaseline === undefined
	) {
		throw invalidRequest(
			"Capability activation requires a managed settings baseline",
		);
	}
}

function validatePersonalBaselineCommand(
	command: AgentReleaseApplyCommand,
	now: Date,
): void {
	const signed =
		command.signedManifest.controlPlanePolicy?.personalAgentBaseline;
	const hasCommand = command.settings !== undefined;
	if (!signed && !hasCommand) return;
	if (!signed || !hasCommand) {
		throw invalidRequest(
			"Personal baseline releases require exact resolved settings and identity",
		);
	}
	if (
		command.signedManifest.managedSettings &&
		Object.keys(command.signedManifest.managedSettings).length > 0
	) {
		throw invalidRequest(
			"Personal baseline releases cannot embed mutable managed settings in the manifest",
		);
	}
	const baselineOverride = command.baselineOverride;
	if (baselineOverride) {
		validateBaselineOverride(command, signed, baselineOverride, now);
	} else if (command.baselineVersionId !== signed.baselineVersionId) {
		throw releaseError(
			"agent_release_personal_baseline_id_mismatch",
			409,
			"Personal baseline version does not match the signed manifest",
		);
	}
	if (
		!baselineOverride &&
		command.effectiveSettingsDigest !== signed.effectiveSettingsDigest
	) {
		throw releaseError(
			"agent_release_personal_baseline_digest_mismatch",
			409,
			"Personal baseline digest does not match the signed manifest",
		);
	}
	const expectedDigest = baselineOverride
		? baselineOverride.overrideEffectiveSettingsDigest
		: signed.effectiveSettingsDigest;
	if (!safeDigestEqual(digestValue(command.settings), expectedDigest)) {
		throw releaseError(
			"agent_release_personal_baseline_settings_digest_mismatch",
			409,
			"Resolved personal baseline settings do not match the signed digest",
		);
	}
}

function validateBaselineOverride(
	command: AgentReleaseApplyCommand,
	signed: PersonalAgentBaselineContract,
	override: BaselineOverrideProvenance,
	now: Date,
): void {
	const manifest = command.signedManifest;
	const feed = command.signedFeed;
	if (manifest.environment !== "production" || feed.channel !== "stable") {
		throw releaseError(
			"agent_release_baseline_override_anchor_mismatch",
			409,
			"Break-glass baseline overrides must anchor a production stable release",
		);
	}
	if (new Date(override.approvedAt).getTime() > now.getTime()) {
		throw releaseError(
			"agent_release_baseline_override_not_approved",
			409,
			"Break-glass baseline override approval is not active yet",
		);
	}
	if (new Date(override.expiresAt).getTime() <= now.getTime()) {
		throw releaseError(
			"agent_release_baseline_override_expired",
			409,
			"Break-glass baseline override has expired",
		);
	}
	if (
		override.anchoredReleaseId !== manifest.releaseId ||
		override.anchoredReleaseSequence !== manifest.releaseSequence ||
		override.anchoredFeedSequence !== feed.feedSequence ||
		!safeDigestEqual(override.anchoredFeedDigest, digestValue(feed)) ||
		!safeDigestEqual(override.anchoredManifestDigest, digestValue(manifest)) ||
		override.anchoredBaselineVersionId !== signed.baselineVersionId ||
		override.anchoredBaselineVersion !== signed.baselineVersion ||
		!safeDigestEqual(
			override.anchoredEffectiveSettingsDigest,
			signed.effectiveSettingsDigest,
		)
	) {
		throw releaseError(
			"agent_release_baseline_override_anchor_mismatch",
			409,
			"Break-glass baseline override does not match its signed stable anchor",
		);
	}
	if (
		command.baselineVersionId !== override.overrideBaselineVersionId ||
		command.baselineVersion !== override.overrideBaselineVersion ||
		command.effectiveSettingsDigest !== override.overrideEffectiveSettingsDigest
	) {
		throw releaseError(
			"agent_release_baseline_override_identity_mismatch",
			409,
			"Break-glass baseline override does not match the requested baseline identity",
		);
	}
	if (
		override.overrideBaselineVersionId === signed.baselineVersionId &&
		override.overrideBaselineVersion === signed.baselineVersion &&
		safeDigestEqual(
			override.overrideEffectiveSettingsDigest,
			signed.effectiveSettingsDigest,
		)
	) {
		throw releaseError(
			"agent_release_baseline_override_not_distinct",
			409,
			"Break-glass baseline override cannot masquerade as the signed manifest baseline",
		);
	}
}

function assertExpectedSettingsHash(
	command: AgentReleaseApplyCommand,
	settingsHash: string,
): void {
	const expected =
		command.baselineOverride?.overrideEffectiveSettingsDigest ??
		command.signedManifest.controlPlanePolicy?.personalAgentBaseline
			?.effectiveSettingsDigest ??
		command.signedManifest.controlPlanePolicy?.baseline?.settingsHash;
	if (expected !== undefined && !safeDigestEqual(expected, settingsHash)) {
		throw releaseError(
			"agent_release_settings_hash_mismatch",
			409,
			"Applied managed settings do not match the signed baseline hash",
		);
	}
}

function validatePublication(
	command: AgentReleaseApplyCommand,
	now: Date,
): FeedPublication {
	const manifest = command.signedManifest;
	const matching = command.signedFeed.publications.filter(
		(publication) =>
			publication.releaseId === manifest.releaseId &&
			publication.releaseSequence === manifest.releaseSequence,
	);
	if (matching.length !== 1) {
		const sameSequence = command.signedFeed.publications.find(
			(publication) => publication.releaseSequence === manifest.releaseSequence,
		);
		if (sameSequence) {
			throw releaseError(
				"agent_release_publication_identity_mismatch",
				400,
				"Agent release publication identity does not match the signed manifest",
			);
		}
		throw releaseError(
			"agent_release_publication_not_found",
			400,
			"Signed agent release feed does not publish the requested manifest",
		);
	}
	const publication = matching[0];
	if (canonicalize(publication.manifest) !== canonicalize(manifest)) {
		throw releaseError(
			"agent_release_publication_identity_mismatch",
			400,
			"Agent release publication embeds a different signed manifest",
		);
	}
	const manifestDigest = digestValue(manifest);
	if (!safeDigestEqual(publication.manifestDigest, manifestDigest)) {
		throw releaseError(
			"agent_release_publication_digest_mismatch",
			400,
			"Agent release publication digest does not match the signed manifest",
		);
	}
	if (publication.publicationKind === "rollback") {
		if (
			publication.toReleaseSequence !== manifest.releaseSequence ||
			publication.toReleaseId !== manifest.releaseId
		) {
			throw releaseError(
				"agent_release_rollback_target_mismatch",
				409,
				"Signed rollback target does not match the immutable manifest",
			);
		}
		if (new Date(publication.expiresAt as string).getTime() <= now.getTime()) {
			throw releaseError(
				"agent_release_rollback_expired",
				400,
				"Signed rollback publication has expired",
			);
		}
	}
	return publication;
}

function verifySignedManifest(
	manifest: SignedManifest,
	keys: ReadonlyMap<string, KeyObject>,
): void {
	verifySignedValue(
		manifest,
		"signing",
		keys,
		"agent_release_manifest_signature_invalid",
	);
}

function verifySignedFeed(
	feed: SignedFeed,
	keys: ReadonlyMap<string, KeyObject>,
): void {
	verifySignedValue(
		feed,
		"feedSigning",
		keys,
		"agent_release_feed_signature_invalid",
	);
}

function verifySignedValue(
	value: object,
	signingKey: "signing" | "feedSigning",
	keys: ReadonlyMap<string, KeyObject>,
	invalidCode: string,
): void {
	const signing = (value as Record<string, unknown>)[
		signingKey
	] as SigningMetadata;
	const key = keys.get(signing.keyId);
	if (!key) {
		throw releaseError(
			"agent_release_signing_key_unknown",
			403,
			"Agent release signature uses an unknown trusted key id",
		);
	}
	const unsignedSigning = withoutOwnKey(signing, "signature");
	const signedValue = {
		...withoutOwnKey(value, signingKey),
		[signingKey]: unsignedSigning,
	};
	const valid = verifySignature(
		null,
		canonicalBytes(signedValue),
		key,
		Buffer.from(signing.signature, "base64"),
	);
	if (!valid) {
		throw releaseError(invalidCode, 403, "Agent release signature is invalid");
	}
}

function parseTrustedKeyring(value: string | undefined): {
	keys: ReadonlyMap<string, KeyObject>;
	error: AgentReleaseError | null;
} {
	const unavailable = () => ({
		keys: new Map<string, KeyObject>(),
		error: releaseError(
			"agent_release_keyring_unavailable",
			503,
			"Agent release trusted public keyring is missing or malformed",
		),
	});
	if (!value?.trim() || value.length > MAX_KEYRING_BYTES) return unavailable();
	try {
		const parsed = parseStrictJsonBytes(new TextEncoder().encode(value), {
			maxBytes: MAX_KEYRING_BYTES,
			maxDepth: 2,
			maxValues: MAX_KEYRING_KEYS + 1,
		});
		if (!isRecord(parsed)) return unavailable();
		const entries = Object.entries(parsed);
		if (entries.length === 0 || entries.length > MAX_KEYRING_KEYS)
			return unavailable();
		const keys = new Map<string, KeyObject>();
		for (const [keyId, encodedKey] of entries) {
			if (
				!keyId.trim() ||
				typeof encodedKey !== "string" ||
				!isCanonicalBase64(encodedKey)
			) {
				return unavailable();
			}
			const key = createPublicKey({
				key: Buffer.from(encodedKey, "base64"),
				format: "der",
				type: "spki",
			});
			if (key.asymmetricKeyType !== "ed25519") return unavailable();
			keys.set(keyId, key);
		}
		return { keys, error: null };
	} catch {
		return unavailable();
	}
}

interface EvidenceSigner {
	keyId: string;
	privateKey: KeyObject;
}

function parseEvidenceSigner(value: string | undefined): {
	value: EvidenceSigner;
	error: AgentReleaseError | null;
} {
	if (!value?.trim() || value.length > MAX_KEYRING_BYTES) {
		return {
			value: {} as EvidenceSigner,
			error: releaseError(
				"agent_release_evidence_signer_unavailable",
				503,
				"Agent release runtime evidence signer is unavailable",
			),
		};
	}
	try {
		const parsed = parseStrictJsonBytes(new TextEncoder().encode(value), {
			maxBytes: MAX_KEYRING_BYTES,
			maxDepth: 3,
			maxValues: MAX_KEYRING_KEYS + 4,
		});
		if (!isRecord(parsed)) throw new Error("invalid signer");
		assertExactKeys(parsed, ["activeKeyId", "keys"], "evidence signer");
		if (
			typeof parsed.activeKeyId !== "string" ||
			parsed.activeKeyId.trim() === "" ||
			!isRecord(parsed.keys) ||
			!hasOwn(parsed.keys, parsed.activeKeyId)
		)
			throw new Error("invalid active signer");
		const entries = Object.entries(parsed.keys);
		if (entries.length < 1 || entries.length > MAX_KEYRING_KEYS)
			throw new Error("invalid signer keys");
		let active: KeyObject | null = null;
		for (const [keyId, encoded] of entries) {
			if (
				!keyId.trim() ||
				typeof encoded !== "string" ||
				!isCanonicalBase64(encoded)
			) {
				throw new Error("invalid signer key");
			}
			const privateKey = createPrivateKey({
				key: Buffer.from(encoded, "base64"),
				format: "der",
				type: "pkcs8",
			});
			if (privateKey.asymmetricKeyType !== "ed25519")
				throw new Error("invalid signer algorithm");
			if (keyId === parsed.activeKeyId) active = privateKey;
		}
		if (!active) throw new Error("missing active signer");
		return {
			value: { keyId: parsed.activeKeyId, privateKey: active },
			error: null,
		};
	} catch {
		return {
			value: {} as EvidenceSigner,
			error: releaseError(
				"agent_release_evidence_signer_unavailable",
				503,
				"Agent release runtime evidence signer is unavailable",
			),
		};
	}
}

function signPostApplyEvidence(input: {
	command: AgentReleaseApplyCommand & {
		assignmentRevision: string;
		claimToken: string;
		stepOrdinal: number;
		stepLeaseToken: string;
	};
	result: AgentReleaseApplyResult;
	signer: EvidenceSigner;
	now: Date;
}): AgentReleasePostApplyEvidence {
	const observedAt = input.now.toISOString();
	const expiresAt = new Date(input.now.getTime() + 5 * 60_000).toISOString();
	const smokeDigest = digestValue({
		contract: "lobu-managed-settings-readback-v1",
		passed: true,
		settingsHash: input.result.settingsHash,
		...(input.result.baselineVersionId === undefined
			? {}
			: {
					baselineVersionId: input.result.baselineVersionId,
					effectiveSettingsDigest: input.result.effectiveSettingsDigest,
				}),
		...(input.result.baselineOverride === undefined
			? {}
			: { baselineOverride: input.result.baselineOverride }),
		revisionRef: input.result.revisionRef,
	});
	const unsigned = {
		evidenceKind: "post_apply" as const,
		environment: input.command.signedManifest.environment,
		targetId: input.command.assignment.targetId,
		agentId: input.command.assignment.agentId,
		assignmentRevision: input.command.assignmentRevision,
		claimToken: input.command.claimToken,
		stepOrdinal: input.command.stepOrdinal,
		stepLeaseToken: input.command.stepLeaseToken,
		releaseId: input.result.releaseId,
		releaseSequence: input.result.releaseSequence,
		feedSequence: input.result.feedSequence,
		feedDigest: input.result.feedDigest,
		manifestDigest: input.result.manifestDigest,
		revisionRef: input.result.revisionRef,
		settingsHash: input.result.settingsHash,
		...(input.result.baselineVersionId === undefined
			? {}
			: {
					baselineVersionId: input.result.baselineVersionId,
					effectiveSettingsDigest: input.result
						.effectiveSettingsDigest as string,
				}),
		...(input.result.baselineOverride === undefined
			? {}
			: { baselineOverride: input.result.baselineOverride }),
		drifted: input.result.status === "drifted",
		postApplySmoke: { passed: true, digest: smokeDigest },
		observedAt,
		expiresAt,
		evidenceRef: `lobu:managed-settings:${input.result.revisionRef}`,
		evidenceSigning: {
			algorithm: "Ed25519" as const,
			keyId: input.signer.keyId,
		},
	};
	return {
		...unsigned,
		evidenceSigning: {
			...unsigned.evidenceSigning,
			signature: signBytes(
				null,
				canonicalBytes(unsigned),
				input.signer.privateKey,
			).toString("base64"),
		},
	};
}

function isStrictRfc3339(value: string): boolean {
	const match = RFC3339_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return false;
	}
	const days = [
		31,
		isLeapYear(year) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	if (day < 1 || day > days[month - 1]) return false;
	const zone = match[7];
	if (zone !== "Z") {
		const offsetHour = Number(zone.slice(1, 3));
		const offsetMinute = Number(zone.slice(4, 6));
		if (offsetHour > 23 || offsetMinute > 59) return false;
	}
	return Number.isFinite(Date.parse(value));
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function digestAgentReleaseCommand(value: unknown): string {
	assertAgentReleaseJsonValue(value);
	return digestValue(value);
}

function digestValue(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalBytes(value)).digest("hex")}`;
}

function canonicalBytes(value: unknown): Buffer {
	return Buffer.from(canonicalize(value), "utf8");
}

function safeDigestEqual(left: string, right: string): boolean {
	return (
		left.length === right.length && Buffer.from(left).equals(Buffer.from(right))
	);
}

function assertAgentReleaseJsonValue(value: unknown): void {
	try {
		assertJsonValue(value, "$", new WeakSet<object>());
	} catch (error) {
		throw releaseError(
			"agent_release_invalid_json",
			400,
			error instanceof Error
				? error.message
				: "Agent release payload is not I-JSON",
		);
	}
}

function assertJsonValue(
	value: unknown,
	path: string,
	ancestors: WeakSet<object>,
): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		assertValidUnicode(value, path);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error(`${path} must contain a finite number`);
		return;
	}
	if (typeof value !== "object")
		throw new Error(`${path} contains an unsupported value`);
	if (ancestors.has(value)) throw new Error(`${path} cannot contain a cycle`);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!hasOwn(value, String(index)))
					throw new Error(`${path}[${index}] cannot be a hole`);
				assertJsonValue(value[index], `${path}[${index}]`, ancestors);
			}
			for (const key of Reflect.ownKeys(value)) {
				if (key === "length") continue;
				if (
					typeof key === "symbol" ||
					!/^(0|[1-9]\d*)$/.test(key) ||
					Number(key) >= value.length
				) {
					throw new Error(`${path} cannot contain non-index array properties`);
				}
			}
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${path} must contain only plain objects or arrays`);
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "symbol")
				throw new Error(`${path} cannot contain symbol keys`);
			assertValidUnicode(key, `${path} property name`);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw new Error(`${path}.${key} must be an enumerable data property`);
			}
			assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function assertValidUnicode(value: string, path: string): void {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
				throw new Error(`${path} cannot contain an unpaired UTF-16 surrogate`);
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			throw new Error(`${path} cannot contain an unpaired UTF-16 surrogate`);
		}
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key))
			throw invalidRequest(`Unknown agent release ${label} key: ${key}`);
	}
}

function assertRequiredExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	label: string,
): void {
	assertExactKeys(value, [...required, ...optional], label);
	for (const key of required) {
		if (!hasOwn(value, key))
			throw invalidRequest(`Missing agent release ${label} key: ${key}`);
	}
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value))
		throw invalidRequest(`Agent release ${label} must be an object`);
	return value;
}

function parseStringArray(
	value: unknown,
	label: string,
	minimum = 0,
): string[] {
	if (
		!Array.isArray(value) ||
		value.length < minimum ||
		value.length > 64 ||
		!value.every(
			(item) =>
				typeof item === "string" && item.length > 0 && item.length <= 256,
		) ||
		new Set(value).size !== value.length
	)
		throw invalidRequest(`Agent release ${label} is invalid`);
	return value as string[];
}

function parsePositiveIntegerArray(value: unknown, label: string): number[] {
	if (
		!Array.isArray(value) ||
		value.length > 64 ||
		!value.every(
			(item, index) =>
				isPositiveSafeInteger(item) &&
				(index === 0 || Number(item) > Number(value[index - 1])),
		)
	) {
		throw invalidRequest(`Agent release ${label} is invalid`);
	}
	return value as number[];
}

function parsePercentageArray(value: unknown, label: string): number[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 8 ||
		!value.every(
			(item, index) =>
				Number.isSafeInteger(item) &&
				Number(item) > 0 &&
				Number(item) <= 100 &&
				(index === 0 || Number(item) > Number(value[index - 1])),
		) ||
		value.at(-1) !== 100
	) {
		throw invalidRequest(`Agent release ${label} is invalid`);
	}
	return value as number[];
}

function isCanonicalHttpsOrigin(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.origin === value && url.pathname === "/"
		);
	} catch {
		return false;
	}
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function assertManagedNestedKeys(
	label: "modelSelection" | "toolsConfig",
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw invalidManagedSettings(
				`Agent release refused unmanaged ${label} key: ${key}`,
			);
		}
	}
}

function parseEnvironment(
	value: unknown,
	label: string,
): AgentReleaseEnvironment {
	if (value !== "local" && value !== "staging" && value !== "production") {
		throw invalidRequest(`Agent release ${label} environment is invalid`);
	}
	return value;
}

function parseExpectedEnvironment(
	value: string | undefined,
):
	| { value: AgentReleaseEnvironment; error: null }
	| { value: null; error: AgentReleaseError } {
	if (value === "local" || value === "staging" || value === "production") {
		return { value, error: null };
	}
	return {
		value: null,
		error: releaseError(
			"agent_release_environment_unavailable",
			503,
			"AGENT_RELEASE_ENVIRONMENT must be local, staging, or production",
		),
	};
}

function isCanonicalBase64(value: string): boolean {
	if (!value || !BASE64_PATTERN.test(value)) return false;
	return Buffer.from(value, "base64").toString("base64") === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.hasOwn(value, key);
}

function withoutOwnKey(value: object, key: string): Record<string, unknown> {
	const clone = { ...(value as Record<string, unknown>) };
	delete clone[key];
	return clone;
}

function invalidRequest(message: string): AgentReleaseError {
	return releaseError("agent_release_invalid_request", 400, message);
}

function invalidManagedSettings(message: string): AgentReleaseError {
	return releaseError("agent_release_invalid_managed_settings", 400, message);
}

function invalidRollback(message: string): AgentReleaseError {
	return releaseError("agent_release_invalid_rollback", 400, message);
}

function releaseError(
	code: string,
	status: 400 | 403 | 404 | 409 | 503,
	message: string,
): AgentReleaseError {
	return new AgentReleaseError(code, status, message);
}
