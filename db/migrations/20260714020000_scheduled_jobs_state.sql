-- migrate:up

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';

ALTER TABLE public.scheduled_jobs
  DROP CONSTRAINT IF EXISTS scheduled_jobs_state_check;

ALTER TABLE public.scheduled_jobs
  ADD CONSTRAINT scheduled_jobs_state_check
  CHECK (state IN ('staged', 'active'));

DROP INDEX IF EXISTS public.idx_scheduled_jobs_due;

CREATE INDEX idx_scheduled_jobs_due
  ON public.scheduled_jobs (next_run_at)
  WHERE state = 'active' AND NOT paused;

-- migrate:down

DROP INDEX IF EXISTS public.idx_scheduled_jobs_due;

CREATE INDEX idx_scheduled_jobs_due
  ON public.scheduled_jobs (next_run_at)
  WHERE NOT paused;

ALTER TABLE public.scheduled_jobs
  DROP CONSTRAINT IF EXISTS scheduled_jobs_state_check;

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS state;
