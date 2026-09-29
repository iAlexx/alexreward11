-- ALEx Rewards — Phase 16 MEGA remediation
-- 0054_phase16_mission_runtime_financial_hardening.sql
--
-- Multi-exposure reservations per claim + decision↔exposure provenance.
-- Streak producer fairness checkpoints. No production seeds. No money.

BEGIN;

-- Preflight: existing rows must not violate new uniqueness (one row per claim today).
DO $$
BEGIN
    IF EXISTS (
        SELECT mission_claim_id, count(*) AS c
        FROM mission_bonus_exposure_reservations
        GROUP BY mission_claim_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'mission_bonus_exposure_reservations: duplicate mission_claim_id rows block 0054';
    END IF;
END;
$$;

ALTER TABLE mission_bonus_exposure_reservations
    DROP CONSTRAINT IF EXISTS mission_bonus_exposure_reservations_claim_key;

ALTER TABLE mission_bonus_exposure_reservations
    ADD CONSTRAINT mission_bonus_exposure_reservations_claim_period_key
        UNIQUE (mission_claim_id, exposure_period_id);

CREATE TABLE IF NOT EXISTS mission_reward_decision_exposure_periods (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_reward_decision_id UUID NOT NULL
        REFERENCES mission_reward_decisions (id) ON DELETE RESTRICT,
    exposure_limit_id    UUID NOT NULL
        REFERENCES economic_exposure_limits (id) ON DELETE RESTRICT,
    exposure_period_id   UUID NOT NULL
        REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    amount_atomic        BIGINT NOT NULL CHECK (amount_atomic > 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_reward_decision_exposure_periods_decision_period_key
        UNIQUE (mission_reward_decision_id, exposure_period_id)
);

COMMENT ON TABLE mission_reward_decision_exposure_periods IS
    'Phase 16 remediation: immutable provenance linking a mission reward decision to every '
    'evaluated MAX_MISSION_BONUS_DAILY exposure period (global + mission-specific).';

CREATE INDEX IF NOT EXISTS mission_reward_decision_exposure_periods_decision_idx
    ON mission_reward_decision_exposure_periods (mission_reward_decision_id);

CREATE TABLE IF NOT EXISTS mission_streak_producer_checkpoints (
    mission_version_id   UUID NOT NULL REFERENCES mission_versions (id) ON DELETE RESTRICT,
    user_id              UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    last_evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (mission_version_id, user_id)
);

COMMENT ON TABLE mission_streak_producer_checkpoints IS
    'Phase 16 remediation: durable STREAK producer rotation — users with no actionable work '
    'must not permanently occupy the first-N user_id window.';

CREATE TRIGGER mission_streak_producer_checkpoints_set_updated_at
    BEFORE UPDATE ON mission_streak_producer_checkpoints
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0054_phase16_mission_runtime_financial_hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
