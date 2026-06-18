#!/usr/bin/env node
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

export function usage() {
	return [
		"Usage: DATABASE_URL=... node packages/server/scripts/repair-toolbox-personal-agent-memberships.mjs [--apply] [--limit N]",
		"",
		"Dry-run is the default. The script prints counts and affected agent rows only.",
	].join("\n");
}

export function parseArgs(argv) {
	const args = { apply: false, limit: 500 };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") {
			args.apply = true;
			continue;
		}
		if (arg === "--limit") {
			const raw = argv[index + 1];
			const value = Number(raw);
			if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
				throw new Error("--limit must be an integer from 1 to 10000");
			}
			args.limit = value;
			index += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			return { ...args, help: true };
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

export function deterministicMembershipId(organizationId, ownerUserId) {
	const digest = crypto
		.createHash("sha256")
		.update(JSON.stringify(["toolbox-owner-member", organizationId, ownerUserId]))
		.digest("hex")
		.slice(0, 24);
	return `member_${digest}`;
}

export function deterministicToolboxOwnerEmail(organizationId, ownerUserId) {
	const digest = crypto
		.createHash("sha256")
		.update(JSON.stringify([organizationId, ownerUserId]))
		.digest("hex")
		.slice(0, 32);
	return `toolbox-owner-${digest}@toolbox.local`;
}

export function toSummaryRows(rows) {
	return rows.map((row) => ({
		agentId: String(row.agent_id),
		organizationId: String(row.organization_id),
		ownerUserId: String(row.owner_user_id),
		role: "member",
	}));
}

function sanitizeErrorMessage(error, databaseUrl) {
	const message = error instanceof Error ? error.message : String(error);
	return databaseUrl ? message.split(databaseUrl).join("[DATABASE_URL]") : message;
}

async function findMissingMemberships(sql, limit) {
	return sql`
		SELECT a.id AS agent_id, a.organization_id, a.owner_user_id
		FROM agents a
		LEFT JOIN "member" m
		  ON m."organizationId" = a.organization_id
		 AND m."userId" = a.owner_user_id
		WHERE a.id LIKE 'shifu-u-%'
		  AND a.owner_platform = 'toolbox'
		  AND a.owner_user_id IS NOT NULL
		  AND a.owner_user_id <> ''
		  AND m.id IS NULL
		ORDER BY a.updated_at DESC NULLS LAST, a.id ASC
		LIMIT ${limit}
	`;
}

async function repairMissingMemberships(sql, rows) {
	let repairedCount = 0;
	await sql.begin(async (tx) => {
		for (const row of rows) {
			const organizationId = String(row.organization_id);
			const ownerUserId = String(row.owner_user_id);
			await tx`
				INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
				VALUES (
					${ownerUserId},
					${ownerUserId},
					${deterministicToolboxOwnerEmail(organizationId, ownerUserId)},
					true,
					NOW(),
					NOW()
				)
				ON CONFLICT (id) DO NOTHING
			`;
			const inserted = await tx`
				INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
				VALUES (
					${deterministicMembershipId(organizationId, ownerUserId)},
					${organizationId},
					${ownerUserId},
					'member',
					NOW()
				)
				ON CONFLICT ("organizationId", "userId") DO NOTHING
				RETURNING id
			`;
			repairedCount += inserted.length;
		}
	});
	return repairedCount;
}

export async function runCli(argv, env = process.env) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}

	const databaseUrl = env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("DATABASE_URL is required.");
		return 2;
	}

	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const rows = await findMissingMemberships(sql, args.limit);
		const summaryRows = toSummaryRows(rows);
		const summary = {
			mode: args.apply ? "apply" : "dry-run",
			candidatesCount: rows.length,
			...(args.apply
				? { repairedCount: 0 }
				: { wouldRepairCount: rows.length }),
			rows: summaryRows,
		};

		if (args.apply && rows.length > 0) {
			summary.repairedCount = await repairMissingMemberships(sql, rows);
		}

		console.log(JSON.stringify(summary, null, 2));
		return 0;
	} catch (error) {
		console.error(
			JSON.stringify(
				{
					mode: args.apply ? "apply" : "dry-run",
					error: sanitizeErrorMessage(error, databaseUrl),
				},
				null,
				2,
			),
		);
		return 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: null;
if (invokedPath === import.meta.url) {
	process.exitCode = await runCli(process.argv.slice(2));
}
