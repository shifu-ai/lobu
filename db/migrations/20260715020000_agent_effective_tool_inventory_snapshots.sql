-- migrate:up

CREATE TABLE public.agent_effective_tool_inventory_snapshots (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    release_id text NOT NULL,
    release_sequence bigint NOT NULL CHECK (release_sequence > 0),
    capability_snapshot_digest text NOT NULL,
    snapshot_authority text NOT NULL,
    tool_names jsonb NOT NULL,
    inventory_fingerprint text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (organization_id, agent_id, snapshot_authority),
    FOREIGN KEY (organization_id, agent_id)
        REFERENCES agents(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_effective_inventory_names_array_check CHECK (jsonb_typeof(tool_names) = 'array'),
    CONSTRAINT agent_effective_inventory_fingerprint_check
        CHECK (inventory_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_effective_inventory_capability_digest_check
        CHECK (capability_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_effective_inventory_authority_check CHECK (length(snapshot_authority) BETWEEN 1 AND 200),
    CONSTRAINT agent_effective_inventory_expiry_check CHECK (expires_at > observed_at)
);

CREATE INDEX agent_effective_inventory_latest_idx
    ON public.agent_effective_tool_inventory_snapshots
    (organization_id, agent_id, observed_at DESC);

-- migrate:down

DROP TABLE public.agent_effective_tool_inventory_snapshots;
