-- migrate:up

CREATE TABLE public.course_memory_heads (
  organization_id text NOT NULL,
  owner_user_id text NOT NULL,
  agent_id text NOT NULL,
  course_entity_id text NOT NULL,
  applied_revision bigint NOT NULL CHECK (applied_revision > 0),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  memory_event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  receipt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, owner_user_id, agent_id, course_entity_id),
  FOREIGN KEY (organization_id, agent_id)
    REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE public.course_memory_apply_receipts (
  id text PRIMARY KEY,
  receipt_ref text NOT NULL UNIQUE,
  organization_id text NOT NULL,
  owner_user_id text NOT NULL,
  agent_id text NOT NULL,
  course_entity_id text NOT NULL,
  idempotency_key text NOT NULL,
  requested_revision bigint NOT NULL CHECK (requested_revision > 0),
  accepted_revision bigint,
  applied_revision bigint,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  memory_event_id bigint REFERENCES public.events(id) ON DELETE RESTRICT,
  index_status text CHECK (index_status IN ('ready', 'pending', 'failed')),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'pending', 'rejected', 'indeterminate')),
  trace_id text NOT NULL,
  rejection_code text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_memory_apply_receipts_completed_exact CHECK (
    outcome <> 'completed' OR (
      accepted_revision = requested_revision
      AND applied_revision = requested_revision
      AND memory_event_id IS NOT NULL
      AND index_status IS NOT NULL
      AND rejection_code IS NULL
    )
  )
);

ALTER TABLE public.course_memory_heads
  ADD CONSTRAINT course_memory_heads_receipt_fkey
  FOREIGN KEY (receipt_id) REFERENCES public.course_memory_apply_receipts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX course_memory_apply_receipts_org_idempotency_key
  ON public.course_memory_apply_receipts (organization_id, idempotency_key);

CREATE UNIQUE INDEX course_memory_apply_receipts_org_scope_revision
  ON public.course_memory_apply_receipts (
    organization_id,
    owner_user_id,
    agent_id,
    course_entity_id,
    requested_revision
  );

CREATE INDEX course_memory_apply_receipts_scope_observed
  ON public.course_memory_apply_receipts (
    organization_id,
    owner_user_id,
    agent_id,
    course_entity_id,
    observed_at DESC
  );

CREATE INDEX course_memory_apply_receipts_scope_applied
  ON public.course_memory_apply_receipts (
    organization_id,
    owner_user_id,
    agent_id,
    course_entity_id,
    applied_revision DESC,
    id DESC
  )
  WHERE outcome = 'completed';

CREATE FUNCTION public.course_memory_apply_receipts_block_mutation()
  RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'course_memory_apply_receipts is append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_course_memory_apply_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.course_memory_apply_receipts
  FOR EACH ROW EXECUTE FUNCTION public.course_memory_apply_receipts_block_mutation();

-- migrate:down

ALTER TABLE IF EXISTS public.course_memory_heads
  DROP CONSTRAINT IF EXISTS course_memory_heads_receipt_fkey;
DROP TRIGGER IF EXISTS trg_course_memory_apply_receipts_append_only
  ON public.course_memory_apply_receipts;
DROP FUNCTION IF EXISTS public.course_memory_apply_receipts_block_mutation();
DROP TABLE IF EXISTS public.course_memory_apply_receipts;
DROP TABLE IF EXISTS public.course_memory_heads;
