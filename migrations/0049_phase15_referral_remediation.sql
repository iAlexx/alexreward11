-- ALEx Rewards — Phase 15 MEGA remediation
-- 0049_phase15_referral_remediation.sql
--
-- Scope:
--   1) Harden referral_code_policy effective_to closure against first-reference
--      (NEW.effective_to > MAX(referral_codes.created_at) for that policy_version).
--   2) Pin decision-time rate provenance on referral_reward_decisions.
-- No production policy/rate/budget seeds.

BEGIN;

-- ---------------------------------------------------------------------------
-- Code policy: referenced effective_to closure requires after latest code create
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_code_policy_reject_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_referenced boolean;
    v_max_ref timestamptz;
BEGIN
    IF OLD.policy_version IS DISTINCT FROM NEW.policy_version
        OR OLD.code_length IS DISTINCT FROM NEW.code_length
        OR OLD.alphabet IS DISTINCT FROM NEW.alphabet
        OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION 'referral code policy semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to THEN
        RETURN NEW;
    END IF;

    -- Reject non-null rewrites and reopen (non-null → NULL).
    IF OLD.effective_to IS NOT NULL THEN
        RAISE EXCEPTION 'referral code policy effective_to cannot be rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.effective_to IS NULL THEN
        RAISE EXCEPTION 'referral code policy effective_to cannot reopen to NULL'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.effective_to <= OLD.effective_from THEN
        RAISE EXCEPTION 'referral code policy effective_to must be after effective_from'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM referral_codes c
        WHERE c.generation_policy_version = OLD.policy_version
    )
    INTO v_referenced;

    -- Unreferenced: allow first NULL → non-null closure (window CHECK already applied).
    IF NOT v_referenced THEN
        RETURN NEW;
    END IF;

    -- Referenced: only first NULL → non-null closure after all known code creates.
    SELECT MAX(c.created_at)
    INTO v_max_ref
    FROM referral_codes c
    WHERE c.generation_policy_version = OLD.policy_version;

    IF v_max_ref IS NULL OR NEW.effective_to <= v_max_ref THEN
        RAISE EXCEPTION 'referral code policy effective_to must be after latest code reference'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_referral_code_policy_reject_semantic_update() IS
    'Phase 15 remediation: freeze code-policy identity/format. Referenced effective_to '
    'may close once with NEW.effective_to > MAX(referral_codes.created_at). '
    'Non-null rewrites and reopen are rejected.';

-- ---------------------------------------------------------------------------
-- Decision provenance pins (nullable FKs; BASE_RULE keeps membership nulls)
-- ---------------------------------------------------------------------------

ALTER TABLE referral_reward_decisions
    ADD COLUMN IF NOT EXISTS referral_rule_version INTEGER NULL;

ALTER TABLE referral_reward_decisions
    ADD COLUMN IF NOT EXISTS user_membership_id UUID NULL
        REFERENCES user_memberships (id) ON DELETE RESTRICT;

ALTER TABLE referral_reward_decisions
    ADD COLUMN IF NOT EXISTS entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'referral_reward_decisions_referral_rule_version_fkey'
    ) THEN
        ALTER TABLE referral_reward_decisions
            ADD CONSTRAINT referral_reward_decisions_referral_rule_version_fkey
                FOREIGN KEY (referral_rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT;
    END IF;
END;
$$;

COMMENT ON COLUMN referral_reward_decisions.referral_rule_version IS
    'Pinned referral_rule_versions.rule_version when rate was resolved for this decision.';

COMMENT ON COLUMN referral_reward_decisions.user_membership_id IS
    'Pinned user_memberships row when rate_source = MEMBERSHIP_PROFILE; NULL for BASE_RULE.';

COMMENT ON COLUMN referral_reward_decisions.entitlement_rule_version_id IS
    'Pinned membership_benefit_rule_versions row when rate_source = MEMBERSHIP_PROFILE; NULL for BASE_RULE.';

ALTER TABLE referral_reward_decisions
    DROP CONSTRAINT IF EXISTS referral_reward_decisions_rate_provenance_consistent;

ALTER TABLE referral_reward_decisions
    ADD CONSTRAINT referral_reward_decisions_rate_provenance_consistent
        CHECK (
            (
                rate_source IS NULL
                AND referral_rule_version IS NULL
                AND user_membership_id IS NULL
                AND entitlement_rule_version_id IS NULL
            )
            OR (
                rate_source = 'BASE_RULE'
                AND referral_rule_version IS NOT NULL
                AND user_membership_id IS NULL
                AND entitlement_rule_version_id IS NULL
            )
            OR (
                rate_source = 'MEMBERSHIP_PROFILE'
                AND referral_rule_version IS NOT NULL
                AND user_membership_id IS NOT NULL
                AND entitlement_rule_version_id IS NOT NULL
            )
        );

COMMENT ON CONSTRAINT referral_reward_decisions_rate_provenance_consistent
    ON referral_reward_decisions IS
    'When rate is resolved: BASE_RULE forbids membership IDs; MEMBERSHIP_PROFILE requires both. '
    'ISSUED decisions must match referral_reward_events provenance.';

INSERT INTO schema_migrations (version)
VALUES ('0049_phase15_referral_remediation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
