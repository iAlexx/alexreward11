-- ALEx Rewards — Phase 14 Step 10
-- 0040_phase14_rule_version_reference_integrity.sql
--
-- Scope: Risk + Trust rule-version reproducibility —
--   FK (risk), referenced semantic immutability, first-reference FOR SHARE locks.
-- Complements Eligibility 0038/0039. No production seeds. No scoring policy.

BEGIN;

-- ---------------------------------------------------------------------------
-- Risk: snapshot -> rule_version FK (forward-only)
-- ---------------------------------------------------------------------------

ALTER TABLE risk_snapshots
    DROP CONSTRAINT IF EXISTS risk_snapshots_rule_version_fkey;

ALTER TABLE risk_snapshots
    ADD CONSTRAINT risk_snapshots_rule_version_fkey
        FOREIGN KEY (rule_version)
        REFERENCES risk_rule_versions (rule_version)
        ON DELETE RESTRICT
        NOT VALID;

COMMENT ON CONSTRAINT risk_snapshots_rule_version_fkey ON risk_snapshots IS
    'New risk_snapshots.rule_version must reference risk_rule_versions. '
    'NOT VALID: historical rows are not rewritten; validate later.';

-- ---------------------------------------------------------------------------
-- Risk: referenced semantic immutability
-- ---------------------------------------------------------------------------

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
    'Phase 14 Step 10: once risk_snapshots reference a rule_version, freeze '
    'thresholds/weights/actions and provenance. Status lifecycle remains; '
    'effective_to may close once with NEW.effective_to > MAX(calculated_at).';

DROP TRIGGER IF EXISTS risk_rule_versions_reject_referenced_semantic_update
    ON risk_rule_versions;

CREATE TRIGGER risk_rule_versions_reject_referenced_semantic_update
    BEFORE UPDATE ON risk_rule_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_risk_rule_reject_referenced_semantic_update();

-- ---------------------------------------------------------------------------
-- Risk: first-reference FOR SHARE on snapshot INSERT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_risk_snapshot_lock_rule_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.rule_version IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM risk_rule_versions
    WHERE rule_version = NEW.rule_version
    FOR SHARE;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_risk_snapshot_lock_rule_version() IS
    'Phase 14 Step 10: BEFORE INSERT on risk_snapshots acquires FOR SHARE on '
    'the referenced risk_rule_versions row (conflicts with non-key semantic UPDATEs).';

DROP TRIGGER IF EXISTS risk_snapshots_lock_rule_version ON risk_snapshots;

CREATE TRIGGER risk_snapshots_lock_rule_version
    BEFORE INSERT ON risk_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION app_risk_snapshot_lock_rule_version();

-- ---------------------------------------------------------------------------
-- Trust: referenced semantic immutability
-- ---------------------------------------------------------------------------

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
    'Phase 14 Step 10: once trust_snapshots reference a rule_version, freeze '
    'Trust version identity/provenance. Status lifecycle remains; effective_to '
    'may close once with NEW.effective_to > MAX(calculated_at).';

DROP TRIGGER IF EXISTS trust_rule_versions_reject_referenced_semantic_update
    ON trust_rule_versions;

CREATE TRIGGER trust_rule_versions_reject_referenced_semantic_update
    BEFORE UPDATE ON trust_rule_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_trust_rule_reject_referenced_semantic_update();

-- ---------------------------------------------------------------------------
-- Trust: first-reference FOR SHARE on snapshot INSERT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_trust_snapshot_lock_rule_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.rule_version IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM trust_rule_versions
    WHERE rule_version = NEW.rule_version
    FOR SHARE;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_trust_snapshot_lock_rule_version() IS
    'Phase 14 Step 10: BEFORE INSERT on trust_snapshots acquires FOR SHARE on '
    'the referenced trust_rule_versions row.';

DROP TRIGGER IF EXISTS trust_snapshots_lock_rule_version ON trust_snapshots;

CREATE TRIGGER trust_snapshots_lock_rule_version
    BEFORE INSERT ON trust_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION app_trust_snapshot_lock_rule_version();

INSERT INTO schema_migrations (version)
VALUES ('0040_phase14_rule_version_reference_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
