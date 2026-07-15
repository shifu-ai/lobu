import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createProvisioningRoutes, createReleaseAssuranceReadback } from "../provisioning-routes";
import { orgContext } from "../stores/org-context";

const ORG = "org-isolated";
const AGENT = "shifu-u-isolated";
const DIGEST = `sha256:${"a".repeat(64)}`;
const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.close())); });

describe("authenticated agent release readback with isolated Postgres", () => {
	it("full-replaces removed tools and rejects a wrong-release snapshot", async () => {
		const db = new PGlite(); databases.push(db);
		await db.exec(`CREATE TABLE agents (organization_id text, id text, PRIMARY KEY (organization_id,id));
			CREATE TABLE public.agent_release_applies (organization_id text, agent_id text,
				applied_release_id text, applied_release_sequence bigint, status text);`);
		for (const file of ["20260715020000_agent_effective_tool_inventory_snapshots.sql",
			"20260715030000_agent_release_capability_snapshots.sql"]) {
			const source = readFileSync(path.resolve(__dirname, `../../../../../db/migrations/${file}`), "utf8");
			await db.exec(source.split("-- migrate:down")[0]!.replace("-- migrate:up", ""));
		}
		await db.query("INSERT INTO agents VALUES ($1,$2)", [ORG, AGENT]);
		await db.query("INSERT INTO public.agent_release_applies VALUES ($1,$2,'release-1',1,'applied')", [ORG, AGENT]);
		await db.query(`INSERT INTO public.agent_release_capability_snapshots VALUES
			($1,$2,'release-1',1,$3,'["cap.v1"]','2026-07-15T10:00:00Z','2099-01-01T00:00:00Z')`, [ORG, AGENT, DIGEST]);
		await db.query(`INSERT INTO public.agent_effective_tool_inventory_snapshots VALUES
			($1,$2,'release-1',1,$3,'turn-1','["kept","removed"]',$3,'2026-07-15T10:00:00Z','2099-01-01T00:00:00Z')`, [ORG, AGENT, DIGEST]);
		await db.query(`INSERT INTO public.agent_effective_tool_inventory_snapshots VALUES
			($1,$2,'release-1',1,$3,'turn-1','["kept"]',$3,'2026-07-15T10:01:00Z','2099-01-01T00:00:00Z')
			ON CONFLICT (organization_id,agent_id,snapshot_authority) DO UPDATE SET
			tool_names=excluded.tool_names,observed_at=excluded.observed_at`, [ORG, AGENT, DIGEST]);
		const readback = createReleaseAssuranceReadback({ sql: tagged(db),
			findAgentBase: async () => ({ managedReleaseReceipt: { status: "applied" },
				liveManagedSettingsDigest: DIGEST }) });
		const app = authenticatedApp(readback);
		const fresh = await app.request(`/api/provisioning/agents/${AGENT}/release-assurance`);
		expect(fresh.status).toBe(200);
		expect((await fresh.json()).effectiveMcpToolInventory).toMatchObject({ status: "available", names: ["kept"] });
		await db.query("UPDATE public.agent_effective_tool_inventory_snapshots SET observed_at='2019-01-01T00:00:00Z', expires_at='2020-01-01T00:00:00Z'");
		const expired = await app.request(`/api/provisioning/agents/${AGENT}/release-assurance`);
		expect((await expired.json()).effectiveMcpToolInventory).toMatchObject({ status: "missing", names: [] });
		await db.query("UPDATE public.agent_effective_tool_inventory_snapshots SET observed_at='2026-07-15T10:01:00Z', expires_at='2099-01-01T00:00:00Z'");
		await db.query("UPDATE public.agent_release_applies SET applied_release_id='release-2', applied_release_sequence=2");
		const changed = await app.request(`/api/provisioning/agents/${AGENT}/release-assurance`);
		expect((await changed.json()).effectiveMcpToolInventory).toMatchObject({ status: "missing", names: [] });
	});
});

function tagged(db: PGlite) {
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		let text = strings[0] ?? "";
		for (let index = 0; index < values.length; index++) text += `$${index + 1}${strings[index + 1] ?? ""}`;
		return (await db.query(text, values as never[])).rows;
	}) as any;
	sql.json = (value: unknown) => JSON.stringify(value);
	return sql;
}

function authenticatedApp(readback: ReturnType<typeof createReleaseAssuranceReadback>) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { id: "user" }); c.set("session", { id: "pat:test" }); c.set("organizationId", ORG);
		c.set("authSource", "pat"); c.set("mcpAuthInfo", { scopes: ["mcp:admin"] });
		return orgContext.run({ organizationId: ORG }, next);
	});
	app.route("/api/provisioning", createProvisioningRoutes({ releaseAssuranceReadback: readback }));
	return app;
}
