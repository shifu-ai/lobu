import {
	createHash,
	createPublicKey,
	type KeyObject,
	verify as verifySignature,
} from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { type DbClient, getDb } from "../db/client.js";

const MANAGED_SETTING_KEYS = [
	"identityMd",
	"soulMd",
	"userMd",
	"modelSelection",
	"toolsConfig",
] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type AgentReleaseEnvironment = "local" | "staging" | "production";
type PublicationKind = "release" | "rollback";

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
	signing: SigningMetadata;
}

interface FeedPublication {
	releaseId: string;
	releaseSequence: number;
	manifestDigest: string;
	manifest: SignedManifest;
	publicationKind?: PublicationKind;
	rollbackFromReleaseSequence?: number;
}

interface SignedFeed {
	feedVersion: 1;
	feedSequence: number;
	environment: AgentReleaseEnvironment;
	channel: "candidate" | "stable";
	generatedAt: string;
	publications: FeedPublication[];
	feedSigning: SigningMetadata;
}

interface ReleaseAssignment {
	environment: AgentReleaseEnvironment;
	targetId: string;
	toolboxUserId: string;
	agentId: string;
}

export interface AgentReleaseApplyCommand {
	signedManifest: SignedManifest;
	signedFeed: SignedFeed;
	assignment: ReleaseAssignment;
	expectedCurrentReleaseSequence: number | null;
	commandDigest: string;
}

export interface AgentReleaseEvidence {
	ok: true;
	agentId: string;
	releaseId: string;
	releaseSequence: number;
	feedSequence: number;
	manifestDigest: string;
	status: "applied";
	revisionRef: string;
	settingsHash: string;
	appliedAt: string;
}

export interface AgentReleaseApplyResult extends AgentReleaseEvidence {
	idempotent: boolean;
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

export function createAgentReleaseService(options: {
	trustedPublicKeysJson?: string;
	sql?: DbClient;
}) {
	const keyring = parseTrustedKeyring(options.trustedPublicKeysJson);

	return {
		async apply(input: {
			organizationId: string;
			agentId: string;
			command: unknown;
		}): Promise<AgentReleaseApplyResult> {
			const sql = options.sql ?? getDb();
			if (keyring.error) throw keyring.error;
			assertAgentReleaseJsonValue(input.command);
			const command = parseApplyCommand(input.command);
			validateApplyEnvelope(input.agentId, command);
			verifySignedManifest(command.signedManifest, keyring.keys);
			verifySignedFeed(command.signedFeed, keyring.keys);
			const publication = validatePublication(command);
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

			return sql.begin(async (tx) =>
				applyInTransaction(tx, {
					organizationId: input.organizationId,
					agentId: input.agentId,
					command,
					publication,
				}),
			);
		},

		async getEvidence(input: {
			organizationId: string;
			agentId: string;
		}): Promise<AgentReleaseEvidence | null> {
			const sql = options.sql ?? getDb();
			const rows = await sql<ReceiptRow>`
				SELECT r.applied_release_id, r.applied_release_sequence,
				       r.applied_feed_sequence, r.manifest_digest, r.status,
				       r.revision_ref, r.settings_hash, r.applied_at
				FROM agent_release_applies r
				JOIN agents a
				  ON a.organization_id = r.organization_id
				 AND a.id = r.agent_id
				WHERE r.organization_id = ${input.organizationId}
				  AND r.agent_id = ${input.agentId}
				LIMIT 1
			`;
			return rows[0] ? evidenceFromReceipt(input.agentId, rows[0]) : null;
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
	},
): Promise<AgentReleaseApplyResult> {
	const agentRows = await tx<AgentSettingsRow>`
		SELECT owner_user_id, identity_md, soul_md, user_md,
		       model_selection, tools_config
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
		       manifest_digest, status, revision_ref, settings_hash, applied_at
		FROM agent_release_applies
		WHERE organization_id = ${input.organizationId}
		  AND agent_id = ${input.agentId}
		FOR UPDATE
	`;
	const current = receiptRows[0] ?? null;
	const manifest = input.command.signedManifest;
	const feed = input.command.signedFeed;
	const manifestDigest = input.publication.manifestDigest;

	if (current?.applied_release_sequence === manifest.releaseSequence) {
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
		if (feed.feedSequence < current.applied_feed_sequence) {
			throw releaseError(
				"agent_release_feed_replay",
				409,
				"Agent release feed sequence is older than the applied feed",
			);
		}
		if (feed.feedSequence > current.applied_feed_sequence) {
			const advancedRows = await tx<ReceiptRow>`
				UPDATE agent_release_applies SET
					desired_feed_sequence = ${feed.feedSequence},
					applied_feed_sequence = ${feed.feedSequence},
					updated_at = NOW()
				WHERE organization_id = ${input.organizationId}
				  AND agent_id = ${input.agentId}
				RETURNING desired_release_id, desired_release_sequence, desired_feed_sequence,
				          applied_release_id, applied_release_sequence, applied_feed_sequence,
				          manifest_digest, status, revision_ref, settings_hash, applied_at
			`;
			return {
				...evidenceFromReceipt(input.agentId, advancedRows[0]),
				idempotent: true,
			};
		}
		return { ...evidenceFromReceipt(input.agentId, current), idempotent: true };
	}

	const currentReleaseSequence = current?.applied_release_sequence ?? null;
	if (input.command.expectedCurrentReleaseSequence !== currentReleaseSequence) {
		throw releaseError(
			"agent_release_expected_current_mismatch",
			409,
			"Agent release compare-and-set precondition does not match",
		);
	}
	if (current && feed.feedSequence <= current.applied_feed_sequence) {
		throw releaseError(
			"agent_release_feed_replay",
			409,
			"Agent release feed sequence must advance monotonically",
		);
	}

	const publicationKind = input.publication.publicationKind ?? "release";
	if (current && manifest.releaseSequence < current.applied_release_sequence) {
		if (
			publicationKind !== "rollback" ||
			input.publication.rollbackFromReleaseSequence !==
				current.applied_release_sequence
		) {
			throw releaseError(
				"agent_release_stale",
				409,
				"An older ordinary agent release cannot replace a newer applied release",
			);
		}
	} else if (publicationKind === "rollback") {
		throw releaseError(
			"agent_release_invalid_rollback",
			400,
			"A rollback publication must target an older release from the current sequence",
		);
	}

	const settings = manifest.managedSettings;
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
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.agentId}
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
	const settingsHash = digestValue({
		identityMd: updated.identity_md ?? "",
		soulMd: updated.soul_md ?? "",
		userMd: updated.user_md ?? "",
		modelSelection: updated.model_selection ?? {},
		toolsConfig: updated.tools_config ?? {},
	});
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
			manifest_digest, status, revision_ref, settings_hash, error_code,
			created_at, updated_at, applied_at
		) VALUES (
			${input.organizationId}, ${input.agentId}, ${manifest.environment},
			${manifest.releaseId}, ${manifest.releaseSequence}, ${feed.feedSequence},
			${manifest.releaseId}, ${manifest.releaseSequence}, ${feed.feedSequence},
			${manifestDigest}, 'applied', ${revisionRef}, ${settingsHash}, NULL,
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
			manifest_digest = EXCLUDED.manifest_digest,
			status = EXCLUDED.status,
			revision_ref = EXCLUDED.revision_ref,
			settings_hash = EXCLUDED.settings_hash,
			error_code = NULL,
			updated_at = NOW(),
			applied_at = NOW()
		RETURNING desired_release_id, desired_release_sequence, desired_feed_sequence,
		          applied_release_id, applied_release_sequence, applied_feed_sequence,
		          manifest_digest, status, revision_ref, settings_hash, applied_at
	`;
	return {
		...evidenceFromReceipt(input.agentId, receipt[0]),
		idempotent: false,
	};
}

interface AgentSettingsRow {
	owner_user_id: string | null;
	identity_md: string | null;
	soul_md: string | null;
	user_md: string | null;
	model_selection: unknown;
	tools_config: unknown;
}

interface ReceiptRow {
	desired_release_id?: string;
	desired_release_sequence?: number;
	desired_feed_sequence?: number;
	applied_release_id: string;
	applied_release_sequence: number;
	applied_feed_sequence: number;
	manifest_digest: string;
	status: string;
	revision_ref: string;
	settings_hash: string;
	applied_at: Date | string;
}

function evidenceFromReceipt(
	agentId: string,
	row: ReceiptRow,
): AgentReleaseEvidence {
	return {
		ok: true,
		agentId,
		releaseId: row.applied_release_id,
		releaseSequence: Number(row.applied_release_sequence),
		feedSequence: Number(row.applied_feed_sequence),
		manifestDigest: row.manifest_digest,
		status: "applied",
		revisionRef: row.revision_ref,
		settingsHash: row.settings_hash,
		appliedAt:
			row.applied_at instanceof Date
				? row.applied_at.toISOString()
				: new Date(row.applied_at).toISOString(),
	};
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
			"expectedCurrentReleaseSequence",
			"commandDigest",
		],
		"command",
	);
	const signedManifest = parseManifest(value.signedManifest);
	const signedFeed = parseFeed(value.signedFeed);
	const assignment = parseAssignment(value.assignment);
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
		!Number.isFinite(Date.parse(value.createdAt))
	) {
		throw invalidRequest("Agent release createdAt is invalid");
	}
	const managedSettings = parseManagedSettings(value.managedSettings);
	const signing = parseSigningMetadata(value.signing, "manifest");
	return {
		releaseId: value.releaseId,
		releaseSequence: value.releaseSequence,
		environment,
		releaseKind: value.releaseKind,
		createdAt: value.createdAt,
		managedSettings,
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
		!Number.isFinite(Date.parse(value.generatedAt))
	) {
		throw invalidRequest("Agent release feed generatedAt is invalid");
	}
	if (!Array.isArray(value.publications) || value.publications.length === 0) {
		throw invalidRequest("Agent release feed must include a publication");
	}
	const publications = value.publications.map(parsePublication);
	const feedSigning = parseSigningMetadata(value.feedSigning, "feed");
	return {
		feedVersion: 1,
		feedSequence: value.feedSequence,
		environment,
		channel: value.channel,
		generatedAt: value.generatedAt,
		publications,
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
			"rollbackFromReleaseSequence",
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
		value.publicationKind !== "rollback"
	) {
		throw invalidRequest("Agent release publication kind is invalid");
	}
	if (
		value.rollbackFromReleaseSequence !== undefined &&
		!isPositiveSafeInteger(value.rollbackFromReleaseSequence)
	) {
		throw invalidRequest("Agent release rollback source sequence is invalid");
	}
	if (
		value.publicationKind === "rollback" &&
		value.rollbackFromReleaseSequence === undefined
	) {
		throw invalidRequest(
			"Agent release rollback publication requires its source sequence",
		);
	}
	if (
		(value.publicationKind === undefined ||
			value.publicationKind === "release") &&
		value.rollbackFromReleaseSequence !== undefined
	) {
		throw invalidRequest(
			"Ordinary agent release publication cannot declare a rollback source",
		);
	}
	return {
		releaseId: value.releaseId,
		releaseSequence: value.releaseSequence,
		manifestDigest: value.manifestDigest,
		manifest: parseManifest(value.manifest),
		...(value.publicationKind
			? { publicationKind: value.publicationKind }
			: {}),
		...(value.rollbackFromReleaseSequence
			? { rollbackFromReleaseSequence: value.rollbackFromReleaseSequence }
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
): void {
	if (
		command.assignment.agentId !== agentId ||
		command.assignment.environment !== command.signedManifest.environment ||
		command.assignment.environment !== command.signedFeed.environment
	) {
		throw releaseError(
			"agent_release_assignment_scope_mismatch",
			400,
			"Agent release assignment does not match path, manifest, and feed scope",
		);
	}
}

function validatePublication(
	command: AgentReleaseApplyCommand,
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
	if (!value?.trim()) return unavailable();
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || Object.keys(parsed).length === 0)
			return unavailable();
		const keys = new Map<string, KeyObject>();
		for (const [keyId, encodedKey] of Object.entries(parsed)) {
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

function releaseError(
	code: string,
	status: 400 | 403 | 404 | 409 | 503,
	message: string,
): AgentReleaseError {
	return new AgentReleaseError(code, status, message);
}
