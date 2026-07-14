-- migrate:up

ALTER TABLE public.scheduled_jobs
  ADD COLUMN IF NOT EXISTS until_at timestamp with time zone;

-- migrate:down

ALTER TABLE public.scheduled_jobs
  DROP COLUMN IF EXISTS until_at;
