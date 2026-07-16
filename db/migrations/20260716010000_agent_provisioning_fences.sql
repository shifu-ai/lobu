-- migrate:up

CREATE TABLE agent_provisioning_fences (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    target_id text NOT NULL,
    claim_generation bigint NOT NULL,
    claim_token text NOT NULL,
    baseline_version_id text NOT NULL,
    effective_settings_digest text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT agent_provisioning_fences_pkey
        PRIMARY KEY (organization_id, agent_id),
    CONSTRAINT agent_provisioning_fences_agent_fkey
        FOREIGN KEY (organization_id, agent_id)
        REFERENCES agents(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT agent_provisioning_fences_generation_check
        CHECK (claim_generation > 0),
    CONSTRAINT agent_provisioning_fences_target_id_check
        CHECK (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT agent_provisioning_fences_claim_token_check
        CHECK (claim_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    CONSTRAINT agent_provisioning_fences_baseline_version_check
        CHECK (baseline_version_id ~ '^personal-agent-baseline-v1-[0-9a-f]{64}$'),
    CONSTRAINT agent_provisioning_fences_effective_digest_check
        CHECK (effective_settings_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_provisioning_fences_request_digest_check
        CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$')
);

-- migrate:down

DROP TABLE agent_provisioning_fences;
