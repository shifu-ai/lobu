-- migrate:up

CREATE TABLE public.agent_mcp_tool_inventory_snapshots (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    mcp_id text NOT NULL,
    tool_names jsonb NOT NULL,
    inventory_fingerprint text NOT NULL,
    observed_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, agent_id, mcp_id),
    FOREIGN KEY (organization_id, agent_id)
        REFERENCES agents(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT agent_mcp_inventory_names_array_check CHECK (jsonb_typeof(tool_names) = 'array'),
    CONSTRAINT agent_mcp_inventory_fingerprint_check
        CHECK (inventory_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_mcp_inventory_mcp_id_check CHECK (length(mcp_id) BETWEEN 1 AND 200)
);

-- migrate:down

DROP TABLE public.agent_mcp_tool_inventory_snapshots;
