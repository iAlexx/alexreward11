-- ALEx Rewards — Phase 16 Step 5
-- 0053_phase16_mission_reward_issuance.sql
--
-- Scope: mission_reward_decisions + mission_reward_budget_reservations +
-- mission exposure reservations. No production budget/limit/rule seeds. No money.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mission_reward_decision_outcome') THEN
        CREATE TYPE mission_reward_decision_outcome AS ENUM (
            'ISSUED',
            'BLOCKED_PAUSE',
            'BLOCKED_BUDGET',
            'BLOCKED_EXPOSURE',
            'BLOCKED_ELIGIBILITY',
            'SOURCE_EVIDENCE_INVALID',
            'CONFIGURATION_MISSING'
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only mission reward decisions (multiple non-ISSUED audit rows allowed;
-- at most one ISSUED per claim).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mission_reward_decisions (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_claim_id        UUID NOT NULL REFERENCES mission_claims (id) ON DELETE RESTRICT,
    mission_progress_id     UUID NOT NULL REFERENCES mission_progress (id) ON DELETE RESTRICT,
    mission_version_id      UUID NOT NULL REFERENCES mission_versions (id) ON DELETE RESTRICT,
    outcome                 mission_reward_decision_outcome NOT NULL,
    reason_code             TEXT NOT NULL,
    amount_atomic           BIGINT NULL CHECK (amount_atomic IS NULL OR amount_atomic > 0),
    reward_event_id         UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    reward_rule_id          UUID NULL REFERENCES reward_rules (id) ON DELETE RESTRICT,
    reward_rule_version     INTEGER NULL CHECK (reward_rule_version IS NULL OR reward_rule_version > 0),
    asset_id                UUID NULL REFERENCES assets (id) ON DELETE RESTRICT,
    eligibility_decision_id UUID NULL REFERENCES eligibility_decisions (id) ON DELETE RESTRICT,
    budget_period_id        UUID NULL REFERENCES reward_budget_periods (id) ON DELETE RESTRICT,
    exposure_limit_id       UUID NULL REFERENCES economic_exposure_limits (id) ON DELETE RESTRICT,
    exposure_period_id      UUID NULL REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    ledger_transaction_id   UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_reward_decisions_issued_links CHECK (
        (
            outcome = 'ISSUED'
            AND amount_atomic IS NOT NULL
            AND reward_event_id IS NOT NULL
            AND reward_rule_id IS NOT NULL
            AND reward_rule_version IS NOT NULL
            AND asset_id IS NOT NULL
            AND ledger_transaction_id IS NOT NULL
        )
        OR (
            outcome <> 'ISSUED'
            AND reward_event_id IS NULL
            AND ledger_transaction_id IS NULL
        )
    )
);

COMMENT ON TABLE mission_reward_decisions IS
    'Phase 16: durable mission reward issuance decisions. Transient BLOCKED_* rows are '
    'append-only audit; retries remain allowed until an ISSUED row exists. '
    'Post-grant AD reversal cascade is OWNER_POLICY_REQUIRED (not implemented).';

CREATE UNIQUE INDEX IF NOT EXISTS mission_reward_decisions_issued_claim_key
    ON mission_reward_decisions (mission_claim_id)
    WHERE outcome = 'ISSUED';

CREATE INDEX IF NOT EXISTS mission_reward_decisions_claim_idx
    ON mission_reward_decisions (mission_claim_id, decided_at DESC);

CREATE OR REPLACE FUNCTION app_reject_mission_reward_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'mission_reward_decisions are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS mission_reward_decisions_reject_update ON mission_reward_decisions;
CREATE TRIGGER mission_reward_decisions_reject_update
    BEFORE UPDATE ON mission_reward_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_mission_reward_decision_mutation();

DROP TRIGGER IF EXISTS mission_reward_decisions_reject_delete ON mission_reward_decisions;
CREATE TRIGGER mission_reward_decisions_reject_delete
    BEFORE DELETE ON mission_reward_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_mission_reward_decision_mutation();

-- ---------------------------------------------------------------------------
-- Mission budget reservations (not tied to reward_quotes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mission_reward_budget_reservations (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_claim_id     UUID NOT NULL REFERENCES mission_claims (id) ON DELETE RESTRICT,
    budget_period_id     UUID NOT NULL REFERENCES reward_budget_periods (id) ON DELETE RESTRICT,
    amount_atomic        BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at          TIMESTAMPTZ NULL,
    consumed_at          TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_reward_budget_reservations_claim_key UNIQUE (mission_claim_id),
    CONSTRAINT mission_reward_budget_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE mission_reward_budget_reservations IS
    'Phase 16: MISSION-scoped reward_budget_periods capacity reserved/consumed per claim. '
    'Not linked to reward_quotes.';

CREATE INDEX IF NOT EXISTS mission_reward_budget_reservations_period_idx
    ON mission_reward_budget_reservations (budget_period_id)
    WHERE state = 'ACTIVE';

CREATE TRIGGER mission_reward_budget_reservations_set_updated_at
    BEFORE UPDATE ON mission_reward_budget_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Mission exposure reservations (MAX_MISSION_BONUS_DAILY)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mission_bonus_exposure_reservations (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_claim_id     UUID NOT NULL REFERENCES mission_claims (id) ON DELETE RESTRICT,
    exposure_period_id   UUID NOT NULL REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    amount_atomic        BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at          TIMESTAMPTZ NULL,
    consumed_at          TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_bonus_exposure_reservations_claim_key UNIQUE (mission_claim_id),
    CONSTRAINT mission_bonus_exposure_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE mission_bonus_exposure_reservations IS
    'Phase 16: MAX_MISSION_BONUS_DAILY capacity reserved/consumed per mission claim.';

CREATE INDEX IF NOT EXISTS mission_bonus_exposure_reservations_period_idx
    ON mission_bonus_exposure_reservations (exposure_period_id)
    WHERE state = 'ACTIVE';

CREATE TRIGGER mission_bonus_exposure_reservations_set_updated_at
    BEFORE UPDATE ON mission_bonus_exposure_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0053_phase16_mission_reward_issuance')
ON CONFLICT (version) DO NOTHING;

COMMIT;
