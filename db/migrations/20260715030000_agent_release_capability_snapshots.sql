-- migrate:up

CREATE TABLE public.agent_release_capability_snapshots (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    release_id text NOT NULL,
    release_sequence bigint NOT NULL,
    snapshot_digest text NOT NULL,
    capability_ids jsonb NOT NULL,
    observed_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (organization_id, agent_id, release_sequence, snapshot_digest),
    FOREIGN KEY (organization_id, agent_id)
        REFERENCES agents(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_release_capability_snapshot_digest_check
        CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_release_capability_ids_array_check
        CHECK (jsonb_typeof(capability_ids) = 'array'),
    CONSTRAINT agent_release_capability_snapshot_expiry_check
        CHECK (observed_at < expires_at)
);

CREATE INDEX agent_release_capability_snapshots_current_idx
    ON public.agent_release_capability_snapshots (organization_id, agent_id, release_sequence DESC, expires_at DESC);

-- migrate:down

DROP TABLE public.agent_release_capability_snapshots;
