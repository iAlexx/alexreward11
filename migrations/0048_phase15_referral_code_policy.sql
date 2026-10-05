-- ALEx Rewards — Phase 15 Step 7
-- 0048_phase15_referral_code_policy.sql
--
-- Scope: versioned referral code format policy + provenance pin on referral_codes.
-- NO production alphabet/length seed.

BEGIN;

CREATE TABLE IF NOT EXISTS referral_code_policy_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    policy_version      INTEGER NOT NULL CHECK (policy_version > 0),
    code_length         INTEGER NOT NULL CHECK (code_length BETWEEN 8 AND 64),
    alphabet            TEXT NOT NULL,
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL,
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    source_reference    TEXT NULL,
    created_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_code_policy_versions_version_key UNIQUE (policy_version),
    CONSTRAINT referral_code_policy_versions_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT referral_code_policy_versions_alphabet_nonempty
        CHECK (length(alphabet) >= 2)
);

COMMENT ON TABLE referral_code_policy_versions IS
    'Phase 15: versioned referral code length/alphabet authority. No production seed.';

ALTER TABLE referral_code_policy_versions
    DROP CONSTRAINT IF EXISTS referral_code_policy_versions_no_active_overlap;

ALTER TABLE referral_code_policy_versions
    ADD CONSTRAINT referral_code_policy_versions_no_active_overlap
        EXCLUDE USING gist (
            tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

CREATE OR REPLACE FUNCTION app_referral_code_policy_reject_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referral_code_policy_reject_semantic_update ON referral_code_policy_versions;
CREATE TRIGGER referral_code_policy_reject_semantic_update
    BEFORE UPDATE ON referral_code_policy_versions
    FOR EACH ROW EXECUTE FUNCTION app_referral_code_policy_reject_semantic_update();

-- Pin generation policy on newly issued codes (historical rows may remain NULL).
ALTER TABLE referral_codes
    ADD COLUMN IF NOT EXISTS generation_policy_version INTEGER NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'referral_codes_generation_policy_version_fkey'
    ) THEN
        ALTER TABLE referral_codes
            ADD CONSTRAINT referral_codes_generation_policy_version_fkey
                FOREIGN KEY (generation_policy_version)
                REFERENCES referral_code_policy_versions (policy_version)
                ON DELETE RESTRICT;
    END IF;
END;
$$;

COMMENT ON COLUMN referral_codes.generation_policy_version IS
    'Pinned referral_code_policy_versions.policy_version for server-generated codes. '
    'NULL allowed for historical manual/fixture rows only.';

CREATE OR REPLACE FUNCTION app_referral_codes_lock_policy_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.generation_policy_version IS NOT NULL
       AND (TG_OP = 'INSERT'
            OR OLD.generation_policy_version IS DISTINCT FROM NEW.generation_policy_version)
    THEN
        PERFORM 1
        FROM referral_code_policy_versions
        WHERE policy_version = NEW.generation_policy_version
        FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'referral code policy version % not found for lock',
                NEW.generation_policy_version
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referral_codes_lock_policy_version ON referral_codes;
CREATE TRIGGER referral_codes_lock_policy_version
    BEFORE INSERT OR UPDATE OF generation_policy_version ON referral_codes
    FOR EACH ROW EXECUTE FUNCTION app_referral_codes_lock_policy_version();

INSERT INTO schema_migrations (version)
VALUES ('0048_phase15_referral_code_policy')
ON CONFLICT (version) DO NOTHING;

COMMIT;
