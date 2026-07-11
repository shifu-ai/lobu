CREATE TABLE IF NOT EXISTS public.queue_dispatch_receipts (
  idempotency_key text PRIMARY KEY,
  organization_id text,
  queue_name text NOT NULL,
  run_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queue_dispatch_receipts_created_at_idx
  ON public.queue_dispatch_receipts (created_at);
