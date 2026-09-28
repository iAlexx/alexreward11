-- ALEx Rewards — Phase 14 Step 12
-- 0042_phase14_trust_policy_config.sql
--
-- Scope:
--   * trust_rule_versions.policy_config (versioned Trust evaluation policy)
--   * forward-safe ACTIVE/object CHECKs (NOT VALID)
--   * freeze policy_config once referenced by trust_snapshots
--   * no production seed
-- Application parser remains authoritative for semantic validation.

BEGIN;

ALTER TABLE trust_rule_versions
    ADD COLUMN IF NOT EXISTS policy_config JSONB NULL;

COMMENT ON COLUMN trust_rule_versions.policy_config IS
    'Versioned Trust evaluation policy (signals + stateThresholds). '
    'NULL means unconfigured. No production seed in Phase 14 Step 12 (spec §156K).';

ALTER TABLE trust_rule_versions
    DROP CONSTRAINT IF EXISTS trust_rule_versions_active_config_required;

ALTER TABLE trust_rule_versions
    ADD CONSTRAINT trust_rule_versions_active_config_required
        CHECK (
            status <> 'ACTIVE'
            OR policy_config IS NOT NULL
        ) NOT VALID;

COMMENT ON CONSTRAINT trust_rule_versions_active_config_required
    ON trust_rule_versions IS
    'Forward-only: new/updated ACTIVE rows must carry policy_config. '
    'Historical ACTIVE NULL rows (if any) are not rewritten.';

ALTER TABLE trust_rule_versions
    DROP CONSTRAINT IF EXISTS trust_rule_versions_config_object;

ALTER TABLE trust_rule_versions
    ADD CONSTRAINT trust_rule_versions_config_object
        CHECK (
            policy_config IS NULL
            OR jsonb_typeof(policy_config) = 'object'
        ) NOT VALID;

COMMENT ON CONSTRAINT trust_rule_versions_config_object
    ON trust_rule_versions IS
    'Forward-only shape guard: policy_config must be a JSON object when present.';

-- Re-create referenced-trust immutability to include policy_config (extends 0040).
CREATE OR REPLACE FUNCTION app_trust_rule_reject_referenced_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_referenced boolean;
    v_max_calculated_at timestamptz;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM trust_snapshots s
        WHERE s.rule_version = OLD.rule_version
    )
    INTO v_referenced;

    IF NOT v_referenced THEN
        RETURN NEW;
    END IF;

    IF OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.reason IS DISTINCT FROM NEW.reason
        OR OLD.audit_reference IS DISTINCT FROM NEW.audit_reference
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.policy_config IS DISTINCT FROM NEW.policy_config
    THEN
        RAISE EXCEPTION
            'referenced trust rule version semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to THEN
        RETURN NEW;
    END IF;

    IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL THEN
        SELECT MAX(s.calculated_at)
        INTO v_max_calculated_at
        FROM trust_snapshots s
        WHERE s.rule_version = OLD.rule_version;

        IF v_max_calculated_at IS NULL OR NEW.effective_to <= v_max_calculated_at THEN
            RAISE EXCEPTION
                'referenced trust rule version semantics are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'referenced trust rule version semantics are immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_trust_rule_reject_referenced_semantic_update() IS
    'Phase 14 Step 10/12: once trust_snapshots reference a rule_version, freeze '
    'Trust version identity/provenance and policy_config. Status lifecycle remains; '
    'effective_to may close once with NEW.effective_to > MAX(calculated_at).';

INSERT INTO schema_migrations (version)
VALUES ('0042_phase14_trust_policy_config')
ON CONFLICT (version) DO NOTHING;

COMMIT;
