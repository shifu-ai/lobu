-- migrate:up transaction:false

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS scheduled_jobs_org_idempotency_key_uniq
  ON scheduled_jobs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.scheduled_jobs_org_idempotency_key_uniq;
