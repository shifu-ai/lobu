import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { DbClient } from "../../db/client";
import type { SubagentTask, SubagentResult } from "./types";

const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
export class SubagentArtifactStore {
  constructor(private readonly sql: DbClient) {}
  /** Call only after the child has stopped, so it cannot replace a parent directory during collection. */
  async collect(task: SubagentTask, workspace: string): Promise<SubagentResult["artifacts"]> {
    const root = await realpath(workspace);
    const files: Array<{ id: string; path: string; bytes: Buffer }> = [];
    let total = 0;
    let entries = 0;
    const walk = async (directory: string, depth: number) => {
      if (depth > 12) throw new Error("subagent_artifact_limit");
      for await (const entry of await opendir(directory)) {
        if (++entries > 1000) throw new Error("subagent_artifact_limit");
        if ([".git", "node_modules", "conversation.jsonl"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const rel = relative(root, await realpath(path));
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("subagent_artifact_path_escape");
        if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > MAX_FILE || total + info.size > MAX_TOTAL || files.length >= 32) throw new Error("subagent_artifact_limit");
          const bytes = await file.readFile();
          if (bytes.length > MAX_FILE || total + bytes.length > MAX_TOTAL) throw new Error("subagent_artifact_limit");
          total += bytes.length; files.push({ id: randomUUID(), path: rel, bytes });
        } finally { await file.close(); }
      }
    };
    await walk(root, 0);
    return this.sql.begin(async sql => {
      const live = await sql`SELECT id FROM subagent_tasks WHERE id=${task.id} AND generation=${task.generation}
        AND status='running' AND lease_until>now() AND deadline_at>now() FOR UPDATE`;
      if (!live.length) throw new Error("subagent_artifact_stale_execution");
      await sql`DELETE FROM subagent_artifacts WHERE task_id=${task.id} AND generation=${task.generation}`;
      for (const file of files) await sql`INSERT INTO subagent_artifacts (id,task_id,generation,path,media_type,content,sha256)
        VALUES (${file.id},${task.id},${task.generation},${file.path},'application/octet-stream',
          decode(${file.bytes.toString("base64")},'base64'),${createHash("sha256").update(file.bytes).digest("hex")})`;
      return files.map(file => ({ id: file.id, path: file.path, mediaType: "application/octet-stream", size: file.bytes.length }));
    });
  }
  async get(task: SubagentTask, id: string) {
    const [row] = await this.sql<{ path: string; mediaType: string; size: number; contentBase64: string }>`
      SELECT a.path,a.media_type AS "mediaType",octet_length(a.content) AS size,encode(a.content,'base64') AS "contentBase64"
      FROM subagent_artifacts a JOIN subagent_tasks t ON t.id=a.task_id
      WHERE a.id=${id} AND t.id=${task.id} AND t.organization_id=${task.organizationId} AND t.user_id=${task.userId}
        AND t.agent_id=${task.agentId} AND t.status='completed' AND a.generation=t.generation`;
    return row ?? null;
  }
}
