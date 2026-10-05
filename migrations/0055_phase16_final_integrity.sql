-- ALEx Rewards — Phase 16 FINAL remediation
-- 0055_phase16_final_integrity.sql
--
-- Append-only guard for mission_reward_decision_exposure_periods.
-- No production seeds. No money.

BEGIN;

CREATE OR REPLACE FUNCTION app_reject_mission_reward_decision_exposure_period_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'mission_reward_decision_exposure_periods are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMENT ON FUNCTION app_reject_mission_reward_decision_exposure_period_mutation() IS
    'Phase 16 final: reject UPDATE/DELETE on mission reward exposure decision provenance.';

DROP TRIGGER IF EXISTS mission_reward_decision_exposure_periods_reject_update
    ON mission_reward_decision_exposure_periods;
CREATE TRIGGER mission_reward_decision_exposure_periods_reject_update
    BEFORE UPDATE ON mission_reward_decision_exposure_periods
    FOR EACH ROW EXECUTE FUNCTION app_reject_mission_reward_decision_exposure_period_mutation();

DROP TRIGGER IF EXISTS mission_reward_decision_exposure_periods_reject_delete
    ON mission_reward_decision_exposure_periods;
CREATE TRIGGER mission_reward_decision_exposure_periods_reject_delete
    BEFORE DELETE ON mission_reward_decision_exposure_periods
    FOR EACH ROW EXECUTE FUNCTION app_reject_mission_reward_decision_exposure_period_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0055_phase16_final_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
