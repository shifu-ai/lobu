-- migrate:up

-- Runtime read-model repair proves each LINE completion against at most two
-- durable inbound rows. Keep that tenant/agent/message/time lookup indexable.
CREATE INDEX IF NOT EXISTS runs_runtime_read_model_line_message_lookup
  ON public.runs (
    organization_id,
    (action_input ->> 'agentId'),
    (action_input ->> 'messageId'),
    created_at,
    id
  )
  WHERE queue_name LIKE 'thread_message\_%' ESCAPE '\'
    AND action_input ->> 'platform' = 'line';

-- migrate:down

DROP INDEX IF EXISTS public.runs_runtime_read_model_line_message_lookup;
