import { randomUUID } from "node:crypto";
import type { DbClient } from "../../db/client";
import { CodexCredentialStore, type CodexAccountScope } from "./codex-credentials";

export type CodexAuthFailureCode = "codex_login_failed" | "codex_auth_provider_rejected" |
  "codex_auth_lease_lost" | "codex_auth_storage_unavailable" | "codex_auth_expired" |
  "codex_rpc_timeout" | "codex_rpc_rejected" | "codex_process_closed" |
  "codex_invalid_login_response" | "codex_invalid_auth";

export interface CodexAuthFlow extends CodexAccountScope {
  id: string; accountEpoch: number; generation: number;
  status: "queued" | "awaiting_user" | "connected" | "failed" | "expired" | "cancelled";
  loginId: string | null; userCode: string | null; verificationUrl: string | null;
  expiresAt: string; errorCode: string | null;
}
interface FlowRow {
  id: string; organization_id: string; user_id: string; account_epoch: number; generation: number;
  status: CodexAuthFlow["status"]; login_id: string | null; user_code: string | null;
  verification_url: string | null; expires_at: Date | string; error_code: string | null;
}
function map(row: FlowRow): CodexAuthFlow {
  return { id: row.id, organizationId: row.organization_id, userId: row.user_id,
    accountEpoch: row.account_epoch, generation: row.generation, status: row.status,
    loginId: row.login_id, userCode: row.user_code, verificationUrl: row.verification_url,
    expiresAt: new Date(row.expires_at).toISOString(), errorCode: row.error_code };
}

export class CodexAuthStore {
  constructor(private readonly sql: DbClient) {}

  async start(scope: CodexAccountScope): Promise<CodexAuthFlow> {
    return this.sql.begin(async (sql) => {
      await sql`INSERT INTO subagent_codex_accounts (organization_id,user_id) VALUES (${scope.organizationId},${scope.userId}) ON CONFLICT DO NOTHING`;
      const [account] = await sql<{ epoch: number; credential_ciphertext: string | null }>`SELECT epoch,credential_ciphertext FROM subagent_codex_accounts
        WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId} FOR UPDATE`;
      await sql`UPDATE subagent_codex_auth_flows SET status='expired', updated_at=now(), user_code=NULL
        WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId} AND status IN ('queued','awaiting_user')
          AND (expires_at<=now() OR (status='awaiting_user' AND lease_until<now()))`;
      const [existing] = await sql<FlowRow>`SELECT * FROM subagent_codex_auth_flows WHERE organization_id=${scope.organizationId}
        AND user_id=${scope.userId} AND status IN ('queued','awaiting_user')`;
      if (existing) return map(existing);
      // Reconnecting may select a different ChatGPT account. Invalidate every
      // running holder before the new authorization starts, under the same lock.
      let epoch = account!.epoch;
      if (account!.credential_ciphertext) {
        const [updated] = await sql<{ epoch: number }>`UPDATE subagent_codex_accounts SET epoch=epoch+1,
          credential_ciphertext=NULL,updated_at=now() WHERE organization_id=${scope.organizationId}
          AND user_id=${scope.userId} RETURNING epoch`;
        epoch = updated!.epoch;
      }
      const [row] = await sql<FlowRow>`INSERT INTO subagent_codex_auth_flows (id,organization_id,user_id,account_epoch)
        VALUES (${randomUUID()},${scope.organizationId},${scope.userId},${epoch}) RETURNING *`;
      return map(row!);
    });
  }

  async get(scope: CodexAccountScope, id: string): Promise<CodexAuthFlow | null> {
    const [row] = await this.sql<FlowRow>`SELECT * FROM subagent_codex_auth_flows WHERE id=${id}
      AND organization_id=${scope.organizationId} AND user_id=${scope.userId}`;
    return row ? map(row) : null;
  }

  async pendingIds(): Promise<string[]> {
    await this.sql`UPDATE subagent_codex_auth_flows SET status='expired', error_code='auth_interrupted_or_expired',
      user_code=NULL, lease_until=NULL, updated_at=now()
      WHERE status IN ('queued','awaiting_user') AND (expires_at<=now() OR (status='awaiting_user' AND lease_until<now()))`;
    const rows = await this.sql<{ id: string }>`SELECT id FROM subagent_codex_auth_flows WHERE status='queued' ORDER BY created_at LIMIT 100`;
    return rows.map((row) => row.id);
  }

  async claim(id: string): Promise<CodexAuthFlow | null> {
    const [row] = await this.sql<FlowRow>`UPDATE subagent_codex_auth_flows SET status='awaiting_user', generation=generation+1,
      lease_until=now()+interval '30 seconds', updated_at=now() WHERE id=${id} AND status='queued' AND expires_at>now() RETURNING *`;
    return row ? map(row) : null;
  }

  async heartbeat(flow: CodexAuthFlow): Promise<boolean> {
    const rows = await this.sql`UPDATE subagent_codex_auth_flows SET lease_until=now()+interval '30 seconds'
      WHERE id=${flow.id} AND generation=${flow.generation} AND status='awaiting_user' AND expires_at>now() AND lease_until>now()
        AND EXISTS (SELECT 1 FROM subagent_codex_accounts a WHERE a.organization_id=subagent_codex_auth_flows.organization_id
          AND a.user_id=subagent_codex_auth_flows.user_id AND a.epoch=subagent_codex_auth_flows.account_epoch) RETURNING id`;
    return rows.length === 1;
  }

  async publishDeviceCode(flow: CodexAuthFlow, data: { loginId: string; userCode: string; verificationUrl: string }): Promise<boolean> {
    // An official authorization link only; never turn arbitrary subprocess text into a login button.
    const url = new URL(data.verificationUrl);
    if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com"].includes(url.hostname) ||
        url.username || url.password || data.userCode.length > 100 || !data.userCode || !data.loginId || data.loginId.length > 200) throw new Error("codex_invalid_login_response");
    const rows = await this.sql`UPDATE subagent_codex_auth_flows SET login_id=${data.loginId},user_code=${data.userCode},
      verification_url=${data.verificationUrl},updated_at=now() WHERE id=${flow.id} AND generation=${flow.generation}
      AND status='awaiting_user' AND expires_at>now() AND lease_until>now() RETURNING id`;
    return rows.length === 1;
  }

  async complete(flow: CodexAuthFlow, authJson: string): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const [account] = await sql<{ epoch: number; credential_revision: number }>`SELECT epoch,credential_revision FROM subagent_codex_accounts
        WHERE organization_id=${flow.organizationId} AND user_id=${flow.userId} FOR UPDATE`;
      if (!account || account.epoch !== flow.accountEpoch) return false;
      const [eligible] = await sql`SELECT id FROM subagent_codex_auth_flows WHERE id=${flow.id} AND organization_id=${flow.organizationId}
        AND user_id=${flow.userId} AND generation=${flow.generation} AND status='awaiting_user'
        AND lease_until>now() AND expires_at>now() FOR UPDATE`;
      if (!eligible) return false;
      if (!(await new CodexCredentialStore(sql).save(flow, account.epoch, account.credential_revision, authJson))) return false;
      await sql`UPDATE subagent_codex_auth_flows SET status='connected',user_code=NULL,lease_until=NULL,updated_at=now() WHERE id=${flow.id}`;
      return true;
    });
  }

  async fail(flow: CodexAuthFlow, code: CodexAuthFailureCode = "codex_login_failed"): Promise<void> {
    await this.sql`UPDATE subagent_codex_auth_flows SET status='failed',error_code=${code},
      user_code=NULL,lease_until=NULL,updated_at=now() WHERE id=${flow.id} AND generation=${flow.generation} AND status='awaiting_user'`;
  }
}
