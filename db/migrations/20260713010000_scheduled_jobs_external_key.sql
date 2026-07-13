-- migrate:up

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS external_key text;

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS schedule_revision bigint NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS public.scheduled_jobs_external_key_unique;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_external_key_unique
  ON public.scheduled_jobs (organization_id, created_by_user, external_key)
  WHERE external_key IS NOT NULL AND created_by_user IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.scheduled_jobs_external_key_unique;

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS schedule_revision;

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS external_key;
