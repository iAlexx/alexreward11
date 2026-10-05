-- ALEx Rewards — Phase 14 Step 6
-- 0035_phase14_trust_rule_core.sql
--
-- Scope: Trust rule-version authority + FK link from trust_snapshots.rule_version.
-- Additive only. Does NOT seed production trust policy, scoring thresholds, weights,
-- or activate any DRAFT/ACTIVE trust rule (OWNER_DECISION_REQUIRED).
--
-- trust_snapshots.rule_version FK is added NOT VALID so:
--   * new writes must reference an existing trust_rule_versions.rule_version
--   * any pre-existing historical trust_snapshots rows are not rewritten/deleted
-- Validation of historical rows can be done later after Owner review.

BEGIN;

CREATE TABLE trust_rule_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    rule_version        INTEGER NOT NULL CHECK (rule_version > 0),
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    audit_reference     TEXT NULL,
    created_by_admin_id UUID NULL
                        REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trust_rule_versions_version_key UNIQUE (rule_version),
    CONSTRAINT trust_rule_versions_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE trust_rule_versions IS
    'Immutable Trust rule versions (Phase 14). Version authority only — scoring '
    'policy thresholds/weights are not stored here until Owner-approved. Trust is '
    'separate from Fraud/Risk and Membership; Founder never auto-creates TRUSTED '
    '(spec §156K).';

ALTER TABLE trust_rule_versions
    DROP CONSTRAINT IF EXISTS trust_rule_versions_no_active_overlap;

ALTER TABLE trust_rule_versions
    ADD CONSTRAINT trust_rule_versions_no_active_overlap
        EXCLUDE USING gist (
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT trust_rule_versions_no_active_overlap ON trust_rule_versions IS
    'At most one ACTIVE Trust rule window may apply at any instant. DRAFT / '
    'SUPERSEDED / REVOKED rows are unrestricted by this guard.';

ALTER TABLE trust_snapshots
    DROP CONSTRAINT IF EXISTS trust_snapshots_rule_version_fkey;

ALTER TABLE trust_snapshots
    ADD CONSTRAINT trust_snapshots_rule_version_fkey
        FOREIGN KEY (rule_version)
        REFERENCES trust_rule_versions (rule_version)
        ON DELETE RESTRICT
        NOT VALID;

COMMENT ON CONSTRAINT trust_snapshots_rule_version_fkey ON trust_snapshots IS
    'New trust_snapshots.rule_version must reference trust_rule_versions. '
    'NOT VALID: historical rows (if any) are not rewritten; validate later.';

INSERT INTO schema_migrations (version)
VALUES ('0035_phase14_trust_rule_core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
