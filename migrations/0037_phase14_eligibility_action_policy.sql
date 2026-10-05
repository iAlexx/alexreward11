-- ALEx Rewards — Phase 14 Step 9
-- 0037_phase14_eligibility_action_policy.sql
--
-- Scope: versioned Eligibility action policy_config column + forward integrity.
-- Additive only. Does NOT seed production policy or invent business thresholds.
-- Application parser remains authoritative for semantic config validation.

BEGIN;

ALTER TABLE eligibility_policy_versions
    ADD COLUMN IF NOT EXISTS policy_config JSONB NULL;

COMMENT ON COLUMN eligibility_policy_versions.policy_config IS
    'Versioned Eligibility action policy (requiredGates + precedence). '
    'NULL means unconfigured. No executable rule language. Owner-controlled; '
    'no production seed in Phase 14 Step 9 (spec §156J).';

ALTER TABLE eligibility_policy_versions
    DROP CONSTRAINT IF EXISTS eligibility_policy_versions_active_config_required;

ALTER TABLE eligibility_policy_versions
    ADD CONSTRAINT eligibility_policy_versions_active_config_required
        CHECK (
            status <> 'ACTIVE'
            OR policy_config IS NOT NULL
        ) NOT VALID;

COMMENT ON CONSTRAINT eligibility_policy_versions_active_config_required
    ON eligibility_policy_versions IS
    'Forward-only: new/updated ACTIVE rows must carry policy_config. '
    'Historical ACTIVE NULL rows (if any) are not rewritten.';

ALTER TABLE eligibility_policy_versions
    DROP CONSTRAINT IF EXISTS eligibility_policy_versions_config_object;

ALTER TABLE eligibility_policy_versions
    ADD CONSTRAINT eligibility_policy_versions_config_object
        CHECK (
            policy_config IS NULL
            OR jsonb_typeof(policy_config) = 'object'
        ) NOT VALID;

COMMENT ON CONSTRAINT eligibility_policy_versions_config_object
    ON eligibility_policy_versions IS
    'Forward-only shape guard: policy_config must be a JSON object when present.';

INSERT INTO schema_migrations (version)
VALUES ('0037_phase14_eligibility_action_policy')
ON CONFLICT (version) DO NOTHING;

COMMIT;
