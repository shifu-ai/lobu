-- migrate:up

-- 狀態與父對話通知共用同一列，終態更新即建立持久化 outbox。
CREATE TABLE public.subagent_tasks (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  agent_id text NOT NULL,
  parent_conversation_id text NOT NULL,
  parent_run_id text NOT NULL,
  parent_message_id text,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  authorization_claim jsonb,
  delegation_context jsonb CHECK (octet_length(delegation_context::text) <= 131072),
  backend text NOT NULL CHECK (backend IN ('codex', 'lobu')),
  title text NOT NULL,
  prompt text NOT NULL,
  child_conversation_id text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  result jsonb,
  error_code text,
  generation integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  delivery_generation integer NOT NULL DEFAULT 0,
  delivery_lease_until timestamptz,
  delivered_at timestamptz,
  observed_execution_id text,
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents (organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, user_id, agent_id, parent_conversation_id, parent_run_id, idempotency_key),
  CHECK (length(title) BETWEEN 1 AND 200),
  CHECK (octet_length(prompt) BETWEEN 1 AND 65536),
  CHECK (octet_length(result::text) <= 262144),
  CHECK ((status IN ('queued','running')) = (completed_at IS NULL))
);

CREATE INDEX subagent_tasks_pending_idx ON public.subagent_tasks (created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX subagent_tasks_owner_idx ON public.subagent_tasks
  (organization_id, user_id, agent_id, parent_conversation_id, created_at);
CREATE INDEX subagent_tasks_delivery_idx ON public.subagent_tasks (completed_at)
  WHERE completed_at IS NOT NULL AND delivered_at IS NULL;

-- Credentials are encrypted in Postgres, so a different replica can execute a task.
-- Epoch fencing prevents an old login/refresh from undoing a disconnect.
CREATE TABLE public.subagent_codex_accounts (
  organization_id text NOT NULL,
  user_id text NOT NULL,
  epoch integer NOT NULL DEFAULT 1,
  credential_revision integer NOT NULL DEFAULT 0,
  credential_ciphertext text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE public.subagent_codex_auth_flows (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  account_epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'awaiting_user', 'connected', 'failed', 'expired', 'cancelled')),
  login_id text,
  user_code text,
  verification_url text,
  generation integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id) REFERENCES subagent_codex_accounts (organization_id, user_id)
);
CREATE UNIQUE INDEX subagent_codex_active_auth ON public.subagent_codex_auth_flows (organization_id, user_id)
  WHERE status IN ('queued', 'awaiting_user');

CREATE TABLE public.subagent_artifacts (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES subagent_tasks(id) ON DELETE CASCADE,
  generation integer NOT NULL, path text NOT NULL, media_type text NOT NULL,
  content bytea NOT NULL, sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,generation,path), CHECK(octet_length(content)<=2097152)
);

-- migrate:down
DROP TABLE IF EXISTS public.subagent_artifacts;
DROP TABLE public.subagent_codex_auth_flows;
DROP TABLE public.subagent_codex_accounts;
DROP TABLE public.subagent_tasks;
