-- ALEx Rewards — Phase 14 Step 9.2
-- 0039_phase14_eligibility_policy_reference_lock.sql
--
-- Scope: serialize first eligibility_decision reference against concurrent
-- semantic UPDATEs on eligibility_policy_versions.
-- Complements 0038 referenced-policy immutability; does not replace it.
-- No production policy seed.

BEGIN;

CREATE OR REPLACE FUNCTION app_eligibility_decision_lock_policy_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- New decisions require policy_version (forward CHECK). Historical NULL
    -- paths are not newly insertable; skip lock if somehow NULL.
    IF NEW.policy_version IS NULL THEN
        RETURN NEW;
    END IF;

    -- FOR SHARE conflicts with normal UPDATE of non-key columns (policy_config,
    -- effective_*, reason, audit_reference, …). FOR KEY SHARE would not.
    -- Missing parent: no row locked; FK remains authoritative for existence.
    PERFORM 1
    FROM eligibility_policy_versions
    WHERE policy_version = NEW.policy_version
    FOR SHARE;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_eligibility_decision_lock_policy_version() IS
    'Phase 14 Step 9.2: BEFORE INSERT on eligibility_decisions acquires FOR SHARE '
    'on the referenced eligibility_policy_versions row so first-reference and '
    'concurrent semantic UPDATEs cannot race past the 0038 freeze guard.';

DROP TRIGGER IF EXISTS eligibility_decisions_lock_policy_version ON eligibility_decisions;

CREATE TRIGGER eligibility_decisions_lock_policy_version
    BEFORE INSERT ON eligibility_decisions
    FOR EACH ROW
    EXECUTE FUNCTION app_eligibility_decision_lock_policy_version();

INSERT INTO schema_migrations (version)
VALUES ('0039_phase14_eligibility_policy_reference_lock')
ON CONFLICT (version) DO NOTHING;

COMMIT;
