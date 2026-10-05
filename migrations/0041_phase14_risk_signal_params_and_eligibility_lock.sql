-- ALEx Rewards — Phase 14 Step 11
-- 0041_phase14_risk_signal_params_and_eligibility_lock.sql
--
-- Scope:
--   * risk_rule_versions.signal_params (versioned per-signal parameters)
--   * freeze signal_params once referenced (extend Step 10 guard)
--   * no production seed
-- Application parser remains authoritative for semantic validation.

BEGIN;

ALTER TABLE risk_rule_versions
    ADD COLUMN IF NOT EXISTS signal_params JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN risk_rule_versions.signal_params IS
    'Versioned per-signal parameters (e.g. history minCount/windowDays). '
    'Empty object when no parameterized signals are configured. No production seed.';

-- Re-create referenced-risk immutability to include signal_params.
CREATE OR REPLACE FUNCTION app_risk_rule_reject_referenced_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_referenced boolean;
    v_max_calculated_at timestamptz;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM risk_snapshots s
        WHERE s.rule_version = OLD.rule_version
    )
    INTO v_referenced;

    IF NOT v_referenced THEN
        RETURN NEW;
    END IF;

    IF OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.thresholds IS DISTINCT FROM NEW.thresholds
        OR OLD.signal_weights IS DISTINCT FROM NEW.signal_weights
        OR OLD.signal_params IS DISTINCT FROM NEW.signal_params
        OR OLD.actions IS DISTINCT FROM NEW.actions
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.reason IS DISTINCT FROM NEW.reason
        OR OLD.audit_reference IS DISTINCT FROM NEW.audit_reference
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'referenced risk rule version semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to THEN
        RETURN NEW;
    END IF;

    IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL THEN
        SELECT MAX(s.calculated_at)
        INTO v_max_calculated_at
        FROM risk_snapshots s
        WHERE s.rule_version = OLD.rule_version;

        IF v_max_calculated_at IS NULL OR NEW.effective_to <= v_max_calculated_at THEN
            RAISE EXCEPTION
                'referenced risk rule version semantics are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'referenced risk rule version semantics are immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_risk_rule_reject_referenced_semantic_update() IS
    'Phase 14 Step 10/11: once risk_snapshots reference a rule_version, freeze '
    'thresholds/weights/params/actions and provenance. Status lifecycle remains; '
    'effective_to may close once with NEW.effective_to > MAX(calculated_at).';

INSERT INTO schema_migrations (version)
VALUES ('0041_phase14_risk_signal_params_and_eligibility_lock')
ON CONFLICT (version) DO NOTHING;

COMMIT;
