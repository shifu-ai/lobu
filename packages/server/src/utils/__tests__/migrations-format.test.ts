import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Migrations live at the repo root, not in any one package.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../../db/migrations');

describe('migration files (dbmate format)', () => {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it.each(files)('%s must contain -- migrate:up marker', (file) => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    expect(content).toContain('-- migrate:up');
  });

  it.each(files)('%s must contain -- migrate:down marker', (file) => {
    const content = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    expect(content).toContain('-- migrate:down');
  });
  it('backfills valid singular course ids before creating the canonical array GIN index',()=>{const sql=fs.readFileSync(path.join(MIGRATIONS_DIR,'20260712020000_course_memory_entity_scope.sql'),'utf-8');expect(sql).toContain("jsonb_typeof(metadata->'course_entity_id') = 'string'");expect(sql).toContain("jsonb_set(metadata, '{course_entity_ids}'");expect(sql).toContain("USING gin ((metadata->'course_entity_ids'))");});
  it('pins course memory receipt uniqueness and append-only event references', () => {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, '20260716010000_course_memory_applies.sql'),
      'utf-8'
    );
    expect(sql).toContain('CREATE TABLE public.course_memory_heads');
    expect(sql).toContain('CREATE TABLE public.course_memory_apply_receipts');
    expect(sql).toContain('(organization_id, idempotency_key)');
    expect(sql).toContain('requested_revision');
    expect(sql).toContain('REFERENCES public.events(id) ON DELETE RESTRICT');
    expect(sql).toContain('trg_course_memory_apply_receipts_append_only');
    expect(sql).not.toContain('ON DELETE CASCADE');
  });
});
