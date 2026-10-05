-- ALEx Rewards — Phase 15 FINAL MICRO-FIX
-- 0050_phase15_telegram_referral_transport.sql
--
-- Scope:
--   Harden referral_code_policy_versions for Telegram start-parameter transport:
--     length("ref_") + code_length <= 64  =>  code_length <= 60
--     alphabet subset of [A-Za-z0-9_-] only
-- No production alphabet/length seeds. Do not rewrite existing policy rows.

BEGIN;

-- Fail closed if any existing policy violates Telegram transport limits.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM referral_code_policy_versions
        WHERE code_length > 60
    ) THEN
        RAISE EXCEPTION
            'referral_code_policy_versions.code_length > 60 present; refuse silent rewrite';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM referral_code_policy_versions
        WHERE alphabet !~ '^[A-Za-z0-9_-]+$'
           OR length(alphabet) < 1
    ) THEN
        RAISE EXCEPTION
            'referral_code_policy_versions.alphabet contains Telegram-unsafe characters; refuse silent rewrite';
    END IF;
END $$;

-- Stricter named code_length bound (existing 8..64 CHECK may remain).
ALTER TABLE referral_code_policy_versions
    DROP CONSTRAINT IF EXISTS referral_code_policy_versions_code_length_telegram_start;

ALTER TABLE referral_code_policy_versions
    ADD CONSTRAINT referral_code_policy_versions_code_length_telegram_start
        CHECK (code_length BETWEEN 8 AND 60);

-- Telegram-safe alphabet only (non-empty; uniqueness/entropy remain app-side).
ALTER TABLE referral_code_policy_versions
    DROP CONSTRAINT IF EXISTS referral_code_policy_versions_alphabet_telegram_safe;

ALTER TABLE referral_code_policy_versions
    ADD CONSTRAINT referral_code_policy_versions_alphabet_telegram_safe
        CHECK (alphabet ~ '^[A-Za-z0-9_-]+$' AND length(alphabet) >= 1);

COMMENT ON CONSTRAINT referral_code_policy_versions_code_length_telegram_start
    ON referral_code_policy_versions IS
    'Telegram start param max 64 chars: length(ref_) + code_length <= 64 => code_length <= 60.';

COMMENT ON CONSTRAINT referral_code_policy_versions_alphabet_telegram_safe
    ON referral_code_policy_versions IS
    'Telegram start param alphabet: A-Za-z0-9_- only. No URL-encoding escape hatch.';

INSERT INTO schema_migrations (version)
VALUES ('0050_phase15_telegram_referral_transport')
ON CONFLICT (version) DO NOTHING;

COMMIT;
