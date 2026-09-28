-- ALEx Rewards — Phase 14 Step 7
-- 0036_phase14_eligibility_policy_core.sql
--
-- Scope: Eligibility policy-version authority + forward-enforced decision integrity.
-- Additive only. Does NOT seed production eligibility policy or invent business rules.
--
-- Forward-only NOT VALID checks/FK:
--   * new eligibility_decisions rows must have non-null policy_version + sha256 digest
--   * historical NULL policy_version / inputs_digest rows are not rewritten
-- DELETE immutability added (UPDATE already rejected).

BEGIN;

CREATE TABLE eligibility_policy_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    policy_version      INTEGER NOT NULL CHECK (policy_version > 0),
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    audit_reference     TEXT NULL,
    created_by_admin_id UUID NULL
                        REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT eligibility_policy_versions_version_key UNIQUE (policy_version),
    CONSTRAINT eligibility_policy_versions_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE eligibility_policy_versions IS
    'Immutable Eligibility policy versions (Phase 14). Version authority only — '
    'business eligibility rules are not stored/executed here until Owner-approved '
    '(spec §156J). Eligibility is availability, not money/fraud/trust authority.';

ALTER TABLE eligibility_policy_versions
    DROP CONSTRAINT IF EXISTS eligibility_policy_versions_no_active_overlap;

ALTER TABLE eligibility_policy_versions
    ADD CONSTRAINT eligibility_policy_versions_no_active_overlap
        EXCLUDE USING gist (
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT eligibility_policy_versions_no_active_overlap
    ON eligibility_policy_versions IS
    'At most one ACTIVE Eligibility policy window may apply at any instant. '
    'DRAFT / SUPERSEDED / REVOKED rows are unrestricted by this guard.';

ALTER TABLE eligibility_decisions
    DROP CONSTRAINT IF EXISTS eligibility_decisions_policy_version_fkey;

ALTER TABLE eligibility_decisions
    ADD CONSTRAINT eligibility_decisions_policy_version_fkey
        FOREIGN KEY (policy_version)
        REFERENCES eligibility_policy_versions (policy_version)
        ON DELETE RESTRICT
        NOT VALID;

COMMENT ON CONSTRAINT eligibility_decisions_policy_version_fkey ON eligibility_decisions IS
    'New non-null policy_version must reference eligibility_policy_versions. '
    'NOT VALID: historical NULL/unknown rows are not rewritten; validate later.';

ALTER TABLE eligibility_decisions
    DROP CONSTRAINT IF EXISTS eligibility_decisions_policy_version_required;

ALTER TABLE eligibility_decisions
    ADD CONSTRAINT eligibility_decisions_policy_version_required
        CHECK (policy_version IS NOT NULL) NOT VALID;

COMMENT ON CONSTRAINT eligibility_decisions_policy_version_required ON eligibility_decisions IS
    'Forward-only: new decision rows must set policy_version. Historical NULL allowed.';

ALTER TABLE eligibility_decisions
    DROP CONSTRAINT IF EXISTS eligibility_decisions_inputs_digest_required;

ALTER TABLE eligibility_decisions
    ADD CONSTRAINT eligibility_decisions_inputs_digest_required
        CHECK (
            inputs_digest IS NOT NULL
            AND inputs_digest ~ '^[0-9a-f]{64}$'
        ) NOT VALID;

COMMENT ON CONSTRAINT eligibility_decisions_inputs_digest_required ON eligibility_decisions IS
    'Forward-only: new decision rows must carry internally computed SHA-256 hex digest.';

DROP TRIGGER IF EXISTS eligibility_decisions_reject_delete ON eligibility_decisions;
CREATE TRIGGER eligibility_decisions_reject_delete
    BEFORE DELETE ON eligibility_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0036_phase14_eligibility_policy_core')
ON CONFLICT (version) DO NOTHING;

COMMIT;
