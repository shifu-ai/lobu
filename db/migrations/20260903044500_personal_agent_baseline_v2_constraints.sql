-- migrate:up

ALTER TABLE agent_provisioning_fences
    DROP CONSTRAINT agent_provisioning_fences_baseline_version_check,
    ADD CONSTRAINT agent_provisioning_fences_baseline_version_check
        CHECK (baseline_version_id ~ '^personal-agent-baseline-v[12]-[0-9a-f]{64}$');

ALTER TABLE agent_release_applies
    DROP CONSTRAINT agent_release_applies_personal_baseline_closed,
    ADD CONSTRAINT agent_release_applies_personal_baseline_closed
    CHECK (
        (personal_baseline_version_id IS NULL
            AND personal_baseline_effective_settings_digest IS NULL
            AND personal_baseline_settings IS NULL)
        OR
        (personal_baseline_version_id ~ '^personal-agent-baseline-v[12]-[0-9a-f]{64}$'
            AND personal_baseline_effective_settings_digest ~ '^sha256:[0-9a-f]{64}$'
            AND jsonb_typeof(personal_baseline_settings) = 'object')
    );

-- migrate:down

ALTER TABLE agent_release_applies
    DROP CONSTRAINT agent_release_applies_personal_baseline_closed,
    ADD CONSTRAINT agent_release_applies_personal_baseline_closed
    CHECK (
        (personal_baseline_version_id IS NULL
            AND personal_baseline_effective_settings_digest IS NULL
            AND personal_baseline_settings IS NULL)
        OR
        (personal_baseline_version_id ~ '^personal-agent-baseline-v1-[0-9a-f]{64}$'
            AND personal_baseline_effective_settings_digest ~ '^sha256:[0-9a-f]{64}$'
            AND jsonb_typeof(personal_baseline_settings) = 'object')
    );

ALTER TABLE agent_provisioning_fences
    DROP CONSTRAINT agent_provisioning_fences_baseline_version_check,
    ADD CONSTRAINT agent_provisioning_fences_baseline_version_check
        CHECK (baseline_version_id ~ '^personal-agent-baseline-v1-[0-9a-f]{64}$');
