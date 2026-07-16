-- migrate:up

-- Embedding completion joins immutable completed receipts by organization and
-- memory event. Keep that proof lookup bounded as receipt history grows.
CREATE INDEX IF NOT EXISTS course_memory_apply_receipts_org_memory_event_completed
  ON public.course_memory_apply_receipts (organization_id, memory_event_id)
  WHERE outcome = 'completed';

-- migrate:down

DROP INDEX IF EXISTS public.course_memory_apply_receipts_org_memory_event_completed;
