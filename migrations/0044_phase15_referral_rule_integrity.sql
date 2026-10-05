-- ALEx Rewards — Phase 15 Step 1
-- 0044_phase15_referral_rule_integrity.sql
--
-- Scope: referral_rule_versions authority + semantic immutability, first-reference
-- FOR SHARE locks, edge attribution/state integrity, code identity freeze,
-- referral_reward_events append-only, and reward_rules.referral_eligible.
-- Additive only. NO production seeds. NO referral money / attribution / activation writer.

BEGIN;

-- ---------------------------------------------------------------------------
-- referral_rule_versions (versioned activation + base rate authority)
-- ---------------------------------------------------------------------------

CREATE TABLE referral_rule_versions (
    id                              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    rule_version                    INTEGER NOT NULL CHECK (rule_version > 0),
    activation_account_age_seconds  INTEGER NOT NULL CHECK (activation_account_age_seconds >= 0),
    activation_valid_ad_count       INTEGER NOT NULL CHECK (activation_valid_ad_count >= 0),
    base_rate_bps                   INTEGER NOT NULL CHECK (base_rate_bps BETWEEN 0 AND 10000),
    status                          rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from                  TIMESTAMPTZ NOT NULL,
    effective_to                    TIMESTAMPTZ NULL,
    reason                          TEXT NULL,
    source_reference                TEXT NULL,
    created_by_admin_id             UUID NULL
                                    REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_rule_versions_version_key UNIQUE (rule_version),
    CONSTRAINT referral_rule_versions_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE referral_rule_versions IS
    'Immutable Phase 15 referral rule versions (activation thresholds + base_rate_bps). '
    'No production seeds; Owner-approved values only. No effective-rate formula here.';

ALTER TABLE referral_rule_versions
    DROP CONSTRAINT IF EXISTS referral_rule_versions_no_active_overlap;

ALTER TABLE referral_rule_versions
    ADD CONSTRAINT referral_rule_versions_no_active_overlap
        EXCLUDE USING gist (
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT referral_rule_versions_no_active_overlap ON referral_rule_versions IS
    'At most one ACTIVE referral rule window may apply at any instant. DRAFT / '
    'SUPERSEDED / REVOKED rows are unrestricted by this guard.';

-- ---------------------------------------------------------------------------
-- Semantic immutability (always freeze economics/identity; safe effective_to)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_rule_reject_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_referenced boolean;
    v_max_ref timestamptz;
BEGIN
    IF OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.activation_account_age_seconds IS DISTINCT FROM NEW.activation_account_age_seconds
        OR OLD.activation_valid_ad_count IS DISTINCT FROM NEW.activation_valid_ad_count
        OR OLD.base_rate_bps IS DISTINCT FROM NEW.base_rate_bps
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'referral rule version semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- status / reason / source_reference remain mutable for lifecycle + audit notes.
    IF OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
            SELECT 1
            FROM referral_edges e
            WHERE e.activation_rule_version = OLD.rule_version
        )
        OR EXISTS (
            SELECT 1
            FROM referral_reward_events r
            WHERE r.rule_version = OLD.rule_version
        )
    INTO v_referenced;

    -- Unreferenced: allow freer effective_to closure / rewrite (still subject to window CHECK).
    IF NOT v_referenced THEN
        RETURN NEW;
    END IF;

    -- Referenced: only first NULL → non-null closure after all known references.
    IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL THEN
        SELECT GREATEST(
            (SELECT MAX(e.activated_at)
             FROM referral_edges e
             WHERE e.activation_rule_version = OLD.rule_version),
            (SELECT MAX(r.created_at)
             FROM referral_reward_events r
             WHERE r.rule_version = OLD.rule_version)
        )
        INTO v_max_ref;

        IF v_max_ref IS NULL OR NEW.effective_to <= v_max_ref THEN
            RAISE EXCEPTION
                'referral rule version semantics are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- Reject second rewrite, reopen (non-null → NULL), or any other effective_to change.
    RAISE EXCEPTION
        'referral rule version semantics are immutable'
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_referral_rule_reject_semantic_update() IS
    'Phase 15 Step 1: freeze referral rule economics/identity/provenance. Status and '
    'reason/source_reference remain mutable. Referenced effective_to may close once with '
    'NEW.effective_to > GREATEST(MAX(edge.activated_at), MAX(event.created_at)).';

DROP TRIGGER IF EXISTS referral_rule_versions_reject_semantic_update
    ON referral_rule_versions;

CREATE TRIGGER referral_rule_versions_reject_semantic_update
    BEFORE UPDATE ON referral_rule_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_rule_reject_semantic_update();

-- ---------------------------------------------------------------------------
-- First-reference FOR SHARE locks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_edge_lock_activation_rule_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.activation_rule_version IS NULL AND NEW.activation_rule_version IS NOT NULL THEN
        PERFORM 1
        FROM referral_rule_versions
        WHERE rule_version = NEW.activation_rule_version
        FOR SHARE;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_referral_edge_lock_activation_rule_version() IS
    'Phase 15 Step 1: BEFORE UPDATE on referral_edges acquires FOR SHARE on the '
    'rule version when activation_rule_version is first set (NULL → non-null).';

DROP TRIGGER IF EXISTS referral_edges_lock_activation_rule_version ON referral_edges;

CREATE TRIGGER referral_edges_lock_activation_rule_version
    BEFORE UPDATE ON referral_edges
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_edge_lock_activation_rule_version();

CREATE OR REPLACE FUNCTION app_referral_reward_event_lock_rule_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM referral_rule_versions
    WHERE rule_version = NEW.rule_version
    FOR SHARE;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_referral_reward_event_lock_rule_version() IS
    'Phase 15 Step 1: BEFORE INSERT on referral_reward_events acquires FOR SHARE on '
    'the referenced referral_rule_versions row.';

DROP TRIGGER IF EXISTS referral_reward_events_lock_rule_version ON referral_reward_events;

CREATE TRIGGER referral_reward_events_lock_rule_version
    BEFORE INSERT ON referral_reward_events
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_reward_event_lock_rule_version();

-- ---------------------------------------------------------------------------
-- FKs: activation_rule_version / rule_version → referral_rule_versions
-- VALID when no orphan references exist; otherwise NOT VALID (forward-only).
-- ---------------------------------------------------------------------------

ALTER TABLE referral_edges
    DROP CONSTRAINT IF EXISTS referral_edges_activation_rule_version_fkey;

ALTER TABLE referral_reward_events
    DROP CONSTRAINT IF EXISTS referral_reward_events_rule_version_fkey;

DO $$
DECLARE
    orphan_edges bigint;
    orphan_events bigint;
BEGIN
    SELECT count(*) INTO orphan_edges
    FROM referral_edges e
    WHERE e.activation_rule_version IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM referral_rule_versions v
          WHERE v.rule_version = e.activation_rule_version
      );

    SELECT count(*) INTO orphan_events
    FROM referral_reward_events r
    WHERE NOT EXISTS (
        SELECT 1
        FROM referral_rule_versions v
        WHERE v.rule_version = r.rule_version
    );

    IF orphan_edges = 0 AND orphan_events = 0 THEN
        ALTER TABLE referral_edges
            ADD CONSTRAINT referral_edges_activation_rule_version_fkey
                FOREIGN KEY (activation_rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT;

        ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_rule_version_fkey
                FOREIGN KEY (rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT;
    ELSE
        ALTER TABLE referral_edges
            ADD CONSTRAINT referral_edges_activation_rule_version_fkey
                FOREIGN KEY (activation_rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT
                NOT VALID;

        ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_rule_version_fkey
                FOREIGN KEY (rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT
                NOT VALID;
    END IF;
END;
$$;

COMMENT ON CONSTRAINT referral_edges_activation_rule_version_fkey ON referral_edges IS
    'referral_edges.activation_rule_version references referral_rule_versions.rule_version.';

COMMENT ON CONSTRAINT referral_reward_events_rule_version_fkey ON referral_reward_events IS
    'referral_reward_events.rule_version references referral_rule_versions.rule_version.';

-- ---------------------------------------------------------------------------
-- Edge attribution freeze
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_edge_reject_attribution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.referrer_user_id IS DISTINCT FROM NEW.referrer_user_id
        OR OLD.referred_user_id IS DISTINCT FROM NEW.referred_user_id
        OR OLD.code_id IS DISTINCT FROM NEW.code_id
        OR OLD.attributed_at IS DISTINCT FROM NEW.attributed_at
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'referral edge attribution identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_referral_edge_reject_attribution_mutation() IS
    'Phase 15 Step 1: freeze referrer/referred/code/attributed_at/created_at on edges.';

DROP TRIGGER IF EXISTS referral_edges_reject_attribution_update ON referral_edges;

CREATE TRIGGER referral_edges_reject_attribution_update
    BEFORE UPDATE ON referral_edges
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_edge_reject_attribution_mutation();

-- ---------------------------------------------------------------------------
-- Edge state machine + field consistency
-- ---------------------------------------------------------------------------

ALTER TABLE referral_edges
    DROP CONSTRAINT IF EXISTS referral_edges_state_fields_consistent;

ALTER TABLE referral_edges
    ADD CONSTRAINT referral_edges_state_fields_consistent
        CHECK (
            (
                state = 'PENDING'
                AND activated_at IS NULL
                AND rejected_at IS NULL
                AND rejection_reason IS NULL
                AND activation_rule_version IS NULL
            )
            OR (
                state = 'ACTIVE'
                AND activated_at IS NOT NULL
                AND rejected_at IS NULL
                AND rejection_reason IS NULL
                AND activation_rule_version IS NOT NULL
            )
            OR (
                state = 'REJECTED'
                AND activated_at IS NULL
                AND rejected_at IS NOT NULL
                AND rejection_reason IS NOT NULL
                AND btrim(rejection_reason) <> ''
            )
        );

COMMENT ON CONSTRAINT referral_edges_state_fields_consistent ON referral_edges IS
    'PENDING/ACTIVE/REJECTED field consistency for referral edge lifecycle.';

CREATE OR REPLACE FUNCTION app_referral_edge_enforce_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'PENDING' AND NEW.state IN ('ACTIVE', 'REJECTED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'invalid referral edge state transition from % to %',
        OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION app_referral_edge_enforce_state_machine() IS
    'Phase 15 Step 1: only PENDING→ACTIVE and PENDING→REJECTED are allowed; '
    'terminal states cannot be rewritten.';

DROP TRIGGER IF EXISTS referral_edges_enforce_state_machine ON referral_edges;

CREATE TRIGGER referral_edges_enforce_state_machine
    BEFORE UPDATE ON referral_edges
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_edge_enforce_state_machine();

-- ---------------------------------------------------------------------------
-- Code identity freeze (status remains mutable)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_code_reject_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.code IS DISTINCT FROM NEW.code
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'referral code identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_referral_code_reject_identity_mutation() IS
    'Phase 15 Step 1: freeze user_id/code/created_at on referral_codes; status may change.';

DROP TRIGGER IF EXISTS referral_codes_reject_identity_update ON referral_codes;

CREATE TRIGGER referral_codes_reject_identity_update
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_code_reject_identity_mutation();

-- ---------------------------------------------------------------------------
-- referral_reward_events append-only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_reward_event_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'referral_reward_events are append-only'
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_referral_reward_event_reject_mutation() IS
    'Phase 15 Step 1: reject UPDATE and DELETE on referral_reward_events.';

DROP TRIGGER IF EXISTS referral_reward_events_reject_update ON referral_reward_events;
CREATE TRIGGER referral_reward_events_reject_update
    BEFORE UPDATE ON referral_reward_events
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_reward_event_reject_mutation();

DROP TRIGGER IF EXISTS referral_reward_events_reject_delete ON referral_reward_events;
CREATE TRIGGER referral_reward_events_reject_delete
    BEFORE DELETE ON referral_reward_events
    FOR EACH ROW
    EXECUTE FUNCTION app_referral_reward_event_reject_mutation();

-- ---------------------------------------------------------------------------
-- reward_rules.referral_eligible (fail-closed for new ACTIVE)
-- ---------------------------------------------------------------------------

ALTER TABLE reward_rules
    ADD COLUMN IF NOT EXISTS referral_eligible BOOLEAN NULL;

COMMENT ON COLUMN reward_rules.referral_eligible IS
    'Versioned referral eligibility; NULL = historical unconfigured; fail closed for new ACTIVE.';

ALTER TABLE reward_rules
    DROP CONSTRAINT IF EXISTS reward_rules_active_requires_referral_eligible;

ALTER TABLE reward_rules
    ADD CONSTRAINT reward_rules_active_requires_referral_eligible
        CHECK (status <> 'ACTIVE' OR referral_eligible IS NOT NULL)
        NOT VALID;

COMMENT ON CONSTRAINT reward_rules_active_requires_referral_eligible ON reward_rules IS
    'New ACTIVE reward_rules must set referral_eligible. NOT VALID preserves historical NULL ACTIVE.';

CREATE OR REPLACE FUNCTION app_reject_reward_rule_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.code IS DISTINCT FROM NEW.code
        OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.source_type IS DISTINCT FROM NEW.source_type
        OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
        OR OLD.country_group IS DISTINCT FROM NEW.country_group
        OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
        OR OLD.user_share_bps IS DISTINCT FROM NEW.user_share_bps
        OR OLD.safety_factor_bps IS DISTINCT FROM NEW.safety_factor_bps
        OR OLD.estimated_ecpm_atomic IS DISTINCT FROM NEW.estimated_ecpm_atomic
        OR OLD.min_reward_atomic IS DISTINCT FROM NEW.min_reward_atomic
        OR OLD.max_reward_atomic IS DISTINCT FROM NEW.max_reward_atomic
        OR OLD.fixed_reward_atomic IS DISTINCT FROM NEW.fixed_reward_atomic
        OR OLD.pending_hold_seconds IS DISTINCT FROM NEW.pending_hold_seconds
        OR OLD.quote_ttl_seconds IS DISTINCT FROM NEW.quote_ttl_seconds
        OR OLD.parameters IS DISTINCT FROM NEW.parameters
        OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
        OR OLD.referral_eligible IS DISTINCT FROM NEW.referral_eligible
    THEN
        RAISE EXCEPTION
            'reward_rules financial identity/economics are immutable; create a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_reward_rule_financial_mutation() IS
    'Phase 5 + Phase 15: rejects in-place mutation of financially authoritative reward_rules '
    'fields including referral_eligible. status/valid_to/reason/source_reference/updated_at '
    'remain mutable for lifecycle.';

INSERT INTO schema_migrations (version)
VALUES ('0044_phase15_referral_rule_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
