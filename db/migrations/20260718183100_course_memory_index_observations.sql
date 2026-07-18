-- migrate:up

-- Apply receipts are immutable acceptance facts. Indexing is asynchronous, so
-- its results live in a separate append-only log. `producer_run_id` is the
-- durable monotonic attempt order (runs.id); `observation_sequence` is the
-- append order used for audit and deterministic ties within one producer run.
CREATE TABLE public.course_memory_index_observations (
  observation_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL,
  receipt_id text NOT NULL REFERENCES public.course_memory_apply_receipts(id) ON DELETE RESTRICT,
  owner_user_id text NOT NULL,
  agent_id text NOT NULL,
  course_entity_id text NOT NULL,
  requested_revision bigint NOT NULL CHECK (requested_revision > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key text NOT NULL,
  memory_event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  index_status text NOT NULL CHECK (index_status IN ('ready', 'failed')),
  -- Deliberately not an FK: completed runs are pruned after 30 days, while
  -- reconciliation evidence must survive. The write service validates the
  -- live run's organization, type, and event membership transactionally.
  producer_run_id bigint NOT NULL CHECK (producer_run_id > 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX course_memory_index_observations_producer_event_unique
  ON public.course_memory_index_observations
  (organization_id, producer_run_id, memory_event_id, index_status);

CREATE INDEX course_memory_index_observations_receipt_latest
  ON public.course_memory_index_observations
  (receipt_id, producer_run_id DESC, observation_sequence DESC);

CREATE FUNCTION public.course_memory_index_observations_block_mutation()
  RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'course_memory_index_observations is append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_course_memory_index_observations_append_only
  BEFORE UPDATE OR DELETE ON public.course_memory_index_observations
  FOR EACH ROW EXECUTE FUNCTION public.course_memory_index_observations_block_mutation();

-- migrate:down

DROP TRIGGER IF EXISTS trg_course_memory_index_observations_append_only
  ON public.course_memory_index_observations;
DROP FUNCTION IF EXISTS public.course_memory_index_observations_block_mutation();
DROP TABLE IF EXISTS public.course_memory_index_observations;
