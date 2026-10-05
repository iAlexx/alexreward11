-- ALEx Rewards — Phase 15 Step 4
-- 0046_phase15_referral_rate_provenance.sql
--
-- Scope: pin membership effective-rate provenance on referral_reward_events.
-- REFERRAL_RATE_BOOST is a replacement effective rate profile (not additive).
-- No production rate/seed. No money issuance in this migration.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'referral_rate_source') THEN
        CREATE TYPE referral_rate_source AS ENUM ('BASE_RULE', 'MEMBERSHIP_PROFILE');
    END IF;
END;
$$;

ALTER TABLE referral_reward_events
    ADD COLUMN IF NOT EXISTS rate_source referral_rate_source NULL;

ALTER TABLE referral_reward_events
    ADD COLUMN IF NOT EXISTS user_membership_id UUID NULL
        REFERENCES user_memberships (id) ON DELETE RESTRICT;

ALTER TABLE referral_reward_events
    ADD COLUMN IF NOT EXISTS entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT;

COMMENT ON COLUMN referral_reward_events.rate_source IS
    'Phase 15: BASE_RULE uses referral_rule_versions.base_rate_bps; '
    'MEMBERSHIP_PROFILE uses a single valid REFERRAL_RATE_BOOST FINANCIAL BPS entitlement '
    'as the replacement effective rate (not additive).';

COMMENT ON COLUMN referral_reward_events.user_membership_id IS
    'Pinned user_memberships row when rate_source = MEMBERSHIP_PROFILE.';

COMMENT ON COLUMN referral_reward_events.entitlement_rule_version_id IS
    'Pinned membership_benefit_rule_versions row when rate_source = MEMBERSHIP_PROFILE.';

-- Fail closed if unexpected historical rows already exist without a matching future policy.
DO $$
DECLARE
    existing_count bigint;
BEGIN
    SELECT count(*) INTO existing_count FROM referral_reward_events;
    IF existing_count > 0 THEN
        RAISE EXCEPTION
            'referral_reward_events already has % row(s); refuse fabricating rate provenance',
            existing_count
            USING ERRCODE = 'data_exception';
    END IF;
END;
$$;

ALTER TABLE referral_reward_events
    DROP CONSTRAINT IF EXISTS referral_reward_events_rate_provenance_consistent;

ALTER TABLE referral_reward_events
    ADD CONSTRAINT referral_reward_events_rate_provenance_consistent
        CHECK (
            (
                rate_source IS NULL
                AND user_membership_id IS NULL
                AND entitlement_rule_version_id IS NULL
            )
            OR (
                rate_source = 'BASE_RULE'
                AND user_membership_id IS NULL
                AND entitlement_rule_version_id IS NULL
            )
            OR (
                rate_source = 'MEMBERSHIP_PROFILE'
                AND user_membership_id IS NOT NULL
                AND entitlement_rule_version_id IS NOT NULL
            )
        );

COMMENT ON CONSTRAINT referral_reward_events_rate_provenance_consistent ON referral_reward_events IS
    'BASE_RULE forbids membership IDs; MEMBERSHIP_PROFILE requires both membership + benefit rule.';

-- Forward inserts must set rate_source (NULL only for pre-Step-4 rows, of which there are zero).
ALTER TABLE referral_reward_events
    DROP CONSTRAINT IF EXISTS referral_reward_events_rate_source_required;

ALTER TABLE referral_reward_events
    ADD CONSTRAINT referral_reward_events_rate_source_required
        CHECK (rate_source IS NOT NULL)
        NOT VALID;

COMMENT ON CONSTRAINT referral_reward_events_rate_source_required ON referral_reward_events IS
    'New referral_reward_events rows must pin rate_source. NOT VALID preserves empty historical table.';

COMMIT;
