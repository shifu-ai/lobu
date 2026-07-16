-- migrate:up

CREATE TABLE agent_fenced_provisioning_grants (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    kind text NOT NULL,
    pattern text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT agent_fenced_provisioning_grants_pkey
        PRIMARY KEY (organization_id, agent_id, kind, pattern),
    CONSTRAINT agent_fenced_provisioning_grants_grant_fkey
        FOREIGN KEY (organization_id, agent_id, kind, pattern)
        REFERENCES grants(organization_id, agent_id, kind, pattern)
        ON DELETE CASCADE
);

-- migrate:down

DROP TABLE agent_fenced_provisioning_grants;
