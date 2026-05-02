-- migrate:up
-- Drop chat_connections table. Connection state is now unified in
-- agent_connections, which ChatInstanceManager reads directly.
-- Inline enc:v1: encryption replaces secret:// ref indirection.

DROP TABLE IF EXISTS public.chat_connections;

-- migrate:down
-- Recreate chat_connections for rollback. Data would need to be re-seeded.

CREATE TABLE IF NOT EXISTS public.chat_connections (
    id text PRIMARY KEY,
    platform text NOT NULL,
    template_agent_id text REFERENCES public.agents(id) ON DELETE CASCADE,
    config jsonb NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active',
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_connections_template_agent_id_idx
    ON public.chat_connections (template_agent_id)
    WHERE template_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_connections_platform_idx
    ON public.chat_connections (platform);
