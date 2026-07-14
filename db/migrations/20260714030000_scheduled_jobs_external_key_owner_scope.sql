-- migrate:up

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_external_key_unique
  ON public.scheduled_jobs (organization_id, created_by_user, external_key)
  WHERE external_key IS NOT NULL AND created_by_user IS NOT NULL;

DROP INDEX IF EXISTS public.scheduled_jobs_org_external_key_unique;

-- migrate:down

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_org_external_key_unique
  ON public.scheduled_jobs (organization_id, external_key)
  WHERE external_key IS NOT NULL;

DROP INDEX IF EXISTS public.scheduled_jobs_external_key_unique;
