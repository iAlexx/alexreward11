-- ALEx Rewards — Phase 5 Reward Engine
-- 0013_reward_engine_integrity.sql
--
-- Scope: financial integrity required before Reward Engine monetary authorization.
-- Does NOT edit migrations 0001–0012.
--
-- Exact necessity:
--   1. Prevent overlapping ACTIVE reward_rules for the same logical family (`code`)
--      so concurrent/ambiguous ACTIVE economics fail closed at the database.
--   2. Prevent in-place mutation of financially authoritative fields on:
--        reward_rules, membership_benefit_rule_versions, economic_exposure_limits
--      so historical quote reconstruction cannot be silently rewritten.
--   3. Persist frozen applied-economics evidence + source-started protection on
--      reward_quotes (schema previously stored only rule id/version + amounts).
--
-- Logical reward-rule family: `reward_rules.code`
--   One ACTIVE version window per code at any instant. Resolution context
--   (source_type/provider/country/asset) is applied in application code; if more
--   than one ACTIVE row matches that context, the engine fails closed.

BEGIN;

-- ---------------------------------------------------------------------------
-- Quote reconstruction + started-source protection
-- ---------------------------------------------------------------------------

ALTER TABLE reward_quotes
    ADD COLUMN IF NOT EXISTS applied_economics JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS source_started_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS bonus_unavailable_policy TEXT NULL;

ALTER TABLE reward_quotes
    DROP CONSTRAINT IF EXISTS reward_quotes_bonus_unavailable_policy_check;

ALTER TABLE reward_quotes
    ADD CONSTRAINT reward_quotes_bonus_unavailable_policy_check
        CHECK (
            bonus_unavailable_policy IS NULL
            OR bonus_unavailable_policy IN ('BASE_REWARD_ONLY', 'BLOCK_QUOTE_BEFORE_START')
        );

COMMENT ON COLUMN reward_quotes.applied_economics IS
    'Phase 5: frozen reconstruction evidence for every material financial rule/version '
    'that authorized this quote. Never an unstructured log; never rebuilt from mutable '
    'current rule rows alone.';
COMMENT ON COLUMN reward_quotes.source_started_at IS
    'Phase 5: set when the authoritative simulated/source session validly starts. '
    'Prevents expiry release after a protected start (V1.2 §21.5).';
COMMENT ON COLUMN reward_quotes.bonus_unavailable_policy IS
    'Phase 5: explicit pre-start policy used when evaluating membership bonus. '
    'Required whenever bonus evaluation is in scope; missing policy fails closed.';

-- ---------------------------------------------------------------------------
-- One ACTIVE validity window per reward rule family (`code`)
-- ---------------------------------------------------------------------------

ALTER TABLE reward_rules
    DROP CONSTRAINT IF EXISTS reward_rules_no_active_overlap;

ALTER TABLE reward_rules
    ADD CONSTRAINT reward_rules_no_active_overlap
        EXCLUDE USING gist (
            code WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT reward_rules_no_active_overlap ON reward_rules IS
    'Phase 5: at most one ACTIVE version window per logical rule family (code).';

-- ---------------------------------------------------------------------------
-- Financial field immutability: reward_rules
-- Lifecycle: status, valid_to, updated_at, reason/source_reference may change
-- when superseding/revoking. Economic parameters never mutate in place.
-- ---------------------------------------------------------------------------

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
    THEN
        RAISE EXCEPTION
            'reward_rules financial identity/economics are immutable; create a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_reward_rule_financial_mutation() IS
    'Phase 5: rejects in-place mutation of financially authoritative reward_rules fields. '
    'status/valid_to/reason/source_reference/updated_at remain mutable for lifecycle.';

DROP TRIGGER IF EXISTS reward_rules_reject_financial_update ON reward_rules;
CREATE TRIGGER reward_rules_reject_financial_update
    BEFORE UPDATE ON reward_rules
    FOR EACH ROW
    EXECUTE FUNCTION app_reject_reward_rule_financial_mutation();

-- ---------------------------------------------------------------------------
-- Financial field immutability: membership_benefit_rule_versions
-- Value columns are immutable; status/effective_to/approval metadata may change
-- so ACTIVE windows can be superseded without rewriting economics.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_membership_benefit_rule_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.entitlement_id IS DISTINCT FROM NEW.entitlement_id
        OR OLD.membership_plan_id IS DISTINCT FROM NEW.membership_plan_id
        OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.value_boolean IS DISTINCT FROM NEW.value_boolean
        OR OLD.value_bps IS DISTINCT FROM NEW.value_bps
        OR OLD.value_integer IS DISTINCT FROM NEW.value_integer
        OR OLD.value_atomic IS DISTINCT FROM NEW.value_atomic
        OR OLD.value_enum IS DISTINCT FROM NEW.value_enum
        OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
        OR OLD.is_grandfathered IS DISTINCT FROM NEW.is_grandfathered
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'membership_benefit_rule_versions financial values are immutable; create a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_membership_benefit_rule_financial_mutation() IS
    'Phase 5: rejects mutation of benefit value identity; status/effective_to/approval remain mutable.';

DROP TRIGGER IF EXISTS membership_benefit_rule_versions_reject_update
    ON membership_benefit_rule_versions;
DROP TRIGGER IF EXISTS membership_benefit_rule_versions_reject_financial_update
    ON membership_benefit_rule_versions;
CREATE TRIGGER membership_benefit_rule_versions_reject_financial_update
    BEFORE UPDATE ON membership_benefit_rule_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_reject_membership_benefit_rule_financial_mutation();

-- Prevent overlapping ACTIVE benefit windows for the same entitlement+plan.
ALTER TABLE membership_benefit_rule_versions
    DROP CONSTRAINT IF EXISTS membership_benefit_rule_versions_no_active_overlap;

ALTER TABLE membership_benefit_rule_versions
    ADD CONSTRAINT membership_benefit_rule_versions_no_active_overlap
        EXCLUDE USING gist (
            entitlement_id WITH =,
            (COALESCE(membership_plan_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- Financial field immutability: economic_exposure_limits
-- Limit values immutable; status/effective_to/approval may change for supersession.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_economic_exposure_limit_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.limit_code IS DISTINCT FROM NEW.limit_code
        OR OLD.environment IS DISTINCT FROM NEW.environment
        OR OLD.scope_reference_id IS DISTINCT FROM NEW.scope_reference_id
        OR OLD.country_group IS DISTINCT FROM NEW.country_group
        OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
        OR OLD.limit_atomic IS DISTINCT FROM NEW.limit_atomic
        OR OLD.limit_bps IS DISTINCT FROM NEW.limit_bps
        OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'economic_exposure_limits financial values are immutable; create a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_economic_exposure_limit_financial_mutation() IS
    'Phase 5: rejects mutation of exposure limit values; status/effective_to/approval remain mutable.';

DROP TRIGGER IF EXISTS economic_exposure_limits_reject_update ON economic_exposure_limits;
DROP TRIGGER IF EXISTS economic_exposure_limits_reject_financial_update ON economic_exposure_limits;
CREATE TRIGGER economic_exposure_limits_reject_financial_update
    BEFORE UPDATE ON economic_exposure_limits
    FOR EACH ROW
    EXECUTE FUNCTION app_reject_economic_exposure_limit_financial_mutation();

ALTER TABLE economic_exposure_limits
    DROP CONSTRAINT IF EXISTS economic_exposure_limits_no_active_overlap;

ALTER TABLE economic_exposure_limits
    ADD CONSTRAINT economic_exposure_limits_no_active_overlap
        EXCLUDE USING gist (
            limit_code WITH =,
            environment WITH =,
            (COALESCE(scope_reference_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
            (COALESCE(country_group, '*')) WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

INSERT INTO schema_migrations (version)
VALUES ('0013_reward_engine_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
