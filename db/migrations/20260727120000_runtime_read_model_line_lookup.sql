-- migrate:up transaction:false

-- Runtime read-model repair proves each LINE completion against at most two
-- durable inbound rows. Operational cost: not yet measured against production
-- row count; build concurrently so public.runs reads and writes continue.
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_runtime_read_model_line_message_lookup
  ON public.runs (
    organization_id,
    (action_input ->> 'agentId'),
    (action_input ->> 'messageId'),
    created_at,
    id
  )
  WHERE queue_name LIKE 'thread_message\_%' ESCAPE '\'
    AND action_input ->> 'platform' = 'line';

-- migrate:down transaction:false

-- Rollback is concurrent for the same hot-table write availability guarantee.
DROP INDEX CONCURRENTLY IF EXISTS public.runs_runtime_read_model_line_message_lookup;
