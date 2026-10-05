-- ALEx Rewards — Phase 14 Step 1
-- 0034_phase14_risk_rule_integrity.sql
--
-- Scope: prevent overlapping ACTIVE windows on global risk_rule_versions.
-- Additive only. Does not seed thresholds, activate DRAFT rows, or rewrite history.
--
-- At any instant there must be at most one applicable ACTIVE global risk rule version
-- (spec §77 / §96.0). Matches existing EXCLUDE USING gist patterns used by fee and
-- provider rule tables.

BEGIN;

ALTER TABLE risk_rule_versions
    DROP CONSTRAINT IF EXISTS risk_rule_versions_no_active_overlap;

ALTER TABLE risk_rule_versions
    ADD CONSTRAINT risk_rule_versions_no_active_overlap
        EXCLUDE USING gist (
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT risk_rule_versions_no_active_overlap ON risk_rule_versions IS
    'At most one ACTIVE global risk rule window may apply at any instant. DRAFT / '
    'SUPERSEDED / REVOKED rows are unrestricted by this guard.';

INSERT INTO schema_migrations (version)
VALUES ('0034_phase14_risk_rule_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
