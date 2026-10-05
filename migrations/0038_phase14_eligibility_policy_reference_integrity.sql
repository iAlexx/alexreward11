-- ALEx Rewards — Phase 14 Step 9.1
-- 0038_phase14_eligibility_policy_reference_integrity.sql
--
-- Scope: freeze semantic identity of eligibility_policy_versions once referenced
-- by eligibility_decisions. Additive trigger only. No production policy seed.
-- Status lifecycle and one-shot safe effective_to closure remain allowed.

BEGIN;

CREATE OR REPLACE FUNCTION app_eligibility_policy_reject_referenced_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_referenced boolean;
    v_max_decided_at timestamptz;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM eligibility_decisions d
        WHERE d.policy_version = OLD.policy_version
    )
    INTO v_referenced;

    IF NOT v_referenced THEN
        RETURN NEW;
    END IF;

    -- Once referenced, freeze semantic / provenance identity.
    IF OLD.policy_version IS DISTINCT FROM NEW.policy_version
        OR OLD.policy_config IS DISTINCT FROM NEW.policy_config
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.reason IS DISTINCT FROM NEW.reason
        OR OLD.audit_reference IS DISTINCT FROM NEW.audit_reference
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'referenced eligibility policy version semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- effective_to: unchanged OK; one-shot NULL -> future timestamp after all decided_at.
    IF OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to THEN
        RETURN NEW;
    END IF;

    IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL THEN
        SELECT MAX(d.decided_at)
        INTO v_max_decided_at
        FROM eligibility_decisions d
        WHERE d.policy_version = OLD.policy_version;

        IF v_max_decided_at IS NULL OR NEW.effective_to <= v_max_decided_at THEN
            RAISE EXCEPTION
                'referenced eligibility policy version semantics are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- Reject any other effective_to rewrite (including reopen and second closure).
    RAISE EXCEPTION
        'referenced eligibility policy version semantics are immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_eligibility_policy_reject_referenced_semantic_update() IS
    'Phase 14 Step 9.1: once eligibility_decisions reference a policy_version, '
    'freeze policy_config and provenance. Status lifecycle remains; effective_to '
    'may close once with NEW.effective_to > MAX(decided_at).';

DROP TRIGGER IF EXISTS eligibility_policy_versions_reject_referenced_semantic_update
    ON eligibility_policy_versions;

CREATE TRIGGER eligibility_policy_versions_reject_referenced_semantic_update
    BEFORE UPDATE ON eligibility_policy_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_eligibility_policy_reject_referenced_semantic_update();

INSERT INTO schema_migrations (version)
VALUES ('0038_phase14_eligibility_policy_reference_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
