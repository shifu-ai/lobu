import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
	__dirname,
	"../../../../../db/migrations/20260715010000_queue_consumer_leases.sql",
);

describe("queue consumer lease migration", () => {
	it("persists bounded multi-replica consumer identity and lease facts", () => {
		const sql = readFileSync(migrationPath, "utf8");
		expect(sql).toContain("CREATE TABLE public.queue_consumer_leases");
		expect(sql).toContain("PRIMARY KEY (queue_name, consumer_id)");
		expect(sql).toContain("identity_conflict boolean NOT NULL DEFAULT false");
		expect(sql).toContain("lease_expires_at timestamp with time zone NOT NULL");
		expect(sql).toContain("declared_image_digest ~ '^sha256:[0-9a-f]{64}$'");
	});
});
