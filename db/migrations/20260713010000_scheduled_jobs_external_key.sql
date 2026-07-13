-- migrate:up

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS external_key text;

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_external_key_unique
  ON public.scheduled_jobs (organization_id, external_key)
  WHERE external_key IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.scheduled_jobs_external_key_unique;

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS external_key;
