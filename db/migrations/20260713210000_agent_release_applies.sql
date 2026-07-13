CREATE TABLE agent_release_applies (
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    environment text NOT NULL,
    desired_release_id text NOT NULL,
    desired_release_sequence bigint NOT NULL,
    desired_feed_sequence bigint NOT NULL,
    applied_release_id text NOT NULL,
    applied_release_sequence bigint NOT NULL,
    applied_feed_sequence bigint NOT NULL,
    manifest_digest text NOT NULL,
    status text NOT NULL,
    revision_ref text NOT NULL,
    settings_hash text NOT NULL,
    error_code text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    applied_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT agent_release_applies_pkey
        PRIMARY KEY (organization_id, agent_id),
    CONSTRAINT agent_release_applies_agent_fkey
        FOREIGN KEY (organization_id, agent_id)
        REFERENCES agents(organization_id, id)
        ON DELETE CASCADE,
    CONSTRAINT agent_release_applies_environment_check
        CHECK (environment IN ('local', 'staging', 'production')),
    CONSTRAINT agent_release_applies_status_check
        CHECK (status IN ('applying', 'applied', 'failed')),
    CONSTRAINT agent_release_applies_sequence_check
        CHECK (
            desired_release_sequence > 0
            AND desired_feed_sequence > 0
            AND applied_release_sequence > 0
            AND applied_feed_sequence > 0
        ),
    CONSTRAINT agent_release_applies_manifest_digest_check
        CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT agent_release_applies_settings_hash_check
        CHECK (settings_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX agent_release_applies_status_updated_idx
    ON agent_release_applies (status, updated_at);
