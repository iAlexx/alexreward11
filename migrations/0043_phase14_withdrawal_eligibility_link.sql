-- ALEx Rewards — Phase 14 Step 13
-- 0043_phase14_withdrawal_eligibility_link.sql
--
-- Scope: link withdrawals to the eligibility_decisions evidence row used at
-- request time. Additive FK only. No production policy seed.

BEGIN;

ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS eligibility_decision_id UUID NULL;

COMMENT ON COLUMN withdrawals.eligibility_decision_id IS
    'Phase 14 Step 13: eligibility_decisions.id from preflight evidence for this '
    'withdrawal request. Set once when attaching authoritative Risk/Eligibility. '
    'ON DELETE RESTRICT — decisions are immutable audit rows.';

ALTER TABLE withdrawals
    DROP CONSTRAINT IF EXISTS withdrawals_eligibility_decision_id_fkey;

ALTER TABLE withdrawals
    ADD CONSTRAINT withdrawals_eligibility_decision_id_fkey
        FOREIGN KEY (eligibility_decision_id)
        REFERENCES eligibility_decisions (id)
        ON DELETE RESTRICT;

COMMENT ON CONSTRAINT withdrawals_eligibility_decision_id_fkey ON withdrawals IS
    'Withdrawals may reference an eligibility decision; deleting referenced '
    'decisions is refused (RESTRICT).';

-- Set-once: once linked, eligibility_decision_id cannot change.
CREATE OR REPLACE FUNCTION app_withdrawals_eligibility_decision_set_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.eligibility_decision_id IS NOT NULL
        AND NEW.eligibility_decision_id IS DISTINCT FROM OLD.eligibility_decision_id
    THEN
        RAISE EXCEPTION 'withdrawals.eligibility_decision_id is set-once'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_withdrawals_eligibility_decision_set_once() IS
    'Phase 14 Step 13: eligibility_decision_id is set-once after first assignment.';

DROP TRIGGER IF EXISTS withdrawals_eligibility_decision_set_once ON withdrawals;
CREATE TRIGGER withdrawals_eligibility_decision_set_once
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW
    EXECUTE FUNCTION app_withdrawals_eligibility_decision_set_once();

INSERT INTO schema_migrations (version)
VALUES ('0043_phase14_withdrawal_eligibility_link')
ON CONFLICT (version) DO NOTHING;

COMMIT;
