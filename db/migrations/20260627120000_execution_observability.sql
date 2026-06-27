-- migrate:up

CREATE TABLE IF NOT EXISTS public.execution_tasks (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  session_id text,
  conversation_id text,
  user_id text,
  source text NOT NULL DEFAULT 'unknown',
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting_for_tool', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  final_summary jsonb,
  error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.execution_events (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES public.execution_tasks(id) ON DELETE CASCADE,
  type text NOT NULL,
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_tasks_agent_started
  ON public.execution_tasks (agent_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_tasks_last_event_at
  ON public.execution_tasks (last_event_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_tasks_status
  ON public.execution_tasks (status);

CREATE INDEX IF NOT EXISTS idx_execution_events_task_id_id
  ON public.execution_events (task_id, id);

-- migrate:down

DROP INDEX IF EXISTS public.idx_execution_events_task_id_id;
DROP INDEX IF EXISTS public.idx_execution_tasks_status;
DROP INDEX IF EXISTS public.idx_execution_tasks_last_event_at;
DROP INDEX IF EXISTS public.idx_execution_tasks_agent_started;

DROP TABLE IF EXISTS public.execution_events;
DROP TABLE IF EXISTS public.execution_tasks;
