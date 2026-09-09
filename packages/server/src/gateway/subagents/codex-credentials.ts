import { encrypt, decrypt } from "@lobu/core";
import type { DbClient } from "../../db/client";
import type { SubagentScope } from "./types";

export type CodexAccountScope = Pick<SubagentScope, "organizationId" | "userId">;
export interface CodexCredential { epoch: number; revision: number; authJson: string }

export function validateCodexAuth(authJson: string): void {
  if (Buffer.byteLength(authJson) > 65536) throw new Error("codex_invalid_auth");
  let data: { tokens?: { access_token?: unknown; refresh_token?: unknown } };
  try { data = JSON.parse(authJson); } catch { throw new Error("codex_invalid_auth"); }
  if (!data || typeof data.tokens?.access_token !== "string" || !data.tokens.access_token ||
      typeof data.tokens.refresh_token !== "string" || !data.tokens.refresh_token) throw new Error("codex_invalid_auth");
}

export class CodexCredentialStore {
  constructor(private readonly sql: DbClient) {}

  async load(scope: CodexAccountScope): Promise<CodexCredential | null> {
    const [row] = await this.sql<{ epoch: number; credential_revision: number; credential_ciphertext: string | null }>`
      SELECT epoch, credential_revision, credential_ciphertext FROM subagent_codex_accounts
      WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId}`;
    if (!row?.credential_ciphertext) return null;
    const value = JSON.parse(decrypt(row.credential_ciphertext));
    if (value.organizationId !== scope.organizationId || value.userId !== scope.userId) throw new Error("codex_credential_scope_mismatch");
    validateCodexAuth(value.authJson);
    return { epoch: row.epoch, revision: row.credential_revision, authJson: value.authJson };
  }

  async isCurrent(scope: CodexAccountScope, epoch: number): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM subagent_codex_accounts WHERE organization_id=${scope.organizationId}
      AND user_id=${scope.userId} AND epoch=${epoch} AND credential_ciphertext IS NOT NULL`;
    return rows.length === 1;
  }

  /** Only refresh is serialized across replicas; inference remains concurrent. */
  async refresh(scope: CodexAccountScope, expectedEpoch: number, staleRevision: number,
    refresh: (authJson: string) => Promise<string>): Promise<CodexCredential> {
    return this.sql.begin(async (sql) => {
      await sql`SELECT 1 FROM subagent_codex_accounts WHERE organization_id=${scope.organizationId}
        AND user_id=${scope.userId} FOR UPDATE`;
      const store = new CodexCredentialStore(sql);
      const current = await store.load(scope);
      if (!current || current.epoch !== expectedEpoch) throw new Error("codex_needs_connection");
      if (current.revision !== staleRevision) return current;
      const authJson = await refresh(current.authJson);
      if (!(await store.save(scope, current.epoch, current.revision, authJson))) throw new Error("codex_needs_connection");
      return { epoch: current.epoch, revision: current.revision + 1, authJson };
    });
  }

  async save(scope: CodexAccountScope, expectedEpoch: number, expectedRevision: number, authJson: string): Promise<boolean> {
    validateCodexAuth(authJson);
    const ciphertext = encrypt(JSON.stringify({ organizationId: scope.organizationId, userId: scope.userId, authJson }));
    const rows = await this.sql`UPDATE subagent_codex_accounts SET credential_ciphertext=${ciphertext}, credential_revision=credential_revision+1, updated_at=now()
      WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId} AND epoch=${expectedEpoch} AND credential_revision=${expectedRevision} RETURNING epoch`;
    return rows.length === 1;
  }

  async disconnect(scope: CodexAccountScope): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`INSERT INTO subagent_codex_accounts (organization_id, user_id) VALUES (${scope.organizationId}, ${scope.userId})
        ON CONFLICT (organization_id,user_id) DO UPDATE SET credential_ciphertext=NULL,
          epoch=subagent_codex_accounts.epoch+1, updated_at=now()`;
      await sql`UPDATE subagent_codex_auth_flows SET status='cancelled', lease_until=NULL, updated_at=now()
        WHERE organization_id=${scope.organizationId} AND user_id=${scope.userId} AND status IN ('queued','awaiting_user')`;
    });
  }
}
