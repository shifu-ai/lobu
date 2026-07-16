-- migrate:up

ALTER TABLE agent_release_applies
    ADD COLUMN baseline_override jsonb,
    ADD COLUMN baseline_override_digest text;

ALTER TABLE agent_release_applies
    ADD CONSTRAINT agent_release_applies_baseline_override_closed
    CHECK (
        (baseline_override IS NULL AND baseline_override_digest IS NULL)
        OR (
            jsonb_typeof(baseline_override) = 'object'
            AND baseline_override_digest ~ '^sha256:[0-9a-f]{64}$'
        )
    );

-- migrate:down

ALTER TABLE agent_release_applies
    DROP CONSTRAINT agent_release_applies_baseline_override_closed,
    DROP COLUMN baseline_override_digest,
    DROP COLUMN baseline_override;
