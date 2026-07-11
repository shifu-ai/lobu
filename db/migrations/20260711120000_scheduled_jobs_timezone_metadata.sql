-- migrate:up

ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS schedule_metadata jsonb,
  ADD COLUMN IF NOT EXISTS timezone text,
  ADD COLUMN IF NOT EXISTS until_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- migrate:down

ALTER TABLE scheduled_jobs
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS until_at,
  DROP COLUMN IF EXISTS timezone,
  DROP COLUMN IF EXISTS schedule_metadata;
