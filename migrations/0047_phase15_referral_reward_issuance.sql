-- ALEx Rewards — Phase 15 Step 5
-- 0047_phase15_referral_reward_issuance.sql
--
-- Scope: durable referral bonus decisions + exposure reservations (no quote FK).
-- No production MAX_REFERRAL_BONUS_DAILY seed. No money in this migration.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'referral_reward_decision_outcome') THEN
        CREATE TYPE referral_reward_decision_outcome AS ENUM (
            'ISSUED',
            'SKIPPED',
            'REJECTED_BUDGET'
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only financial decision record (one per originating source reward)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS referral_reward_decisions (
    id                         UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    source_reward_event_id     UUID NOT NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    referral_edge_id           UUID NULL REFERENCES referral_edges (id) ON DELETE RESTRICT,
    outcome                    referral_reward_decision_outcome NOT NULL,
    reason_code                TEXT NOT NULL,
    amount_atomic              BIGINT NULL CHECK (amount_atomic IS NULL OR amount_atomic > 0),
    referrer_reward_event_id   UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    referral_reward_event_id   UUID NULL REFERENCES referral_reward_events (id) ON DELETE RESTRICT,
    exposure_limit_id          UUID NULL REFERENCES economic_exposure_limits (id) ON DELETE RESTRICT,
    exposure_period_id         UUID NULL REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    rate_bps                   INTEGER NULL CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
    rate_source                referral_rate_source NULL,
    decided_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_reward_decisions_source_key UNIQUE (source_reward_event_id),
    CONSTRAINT referral_reward_decisions_issued_links CHECK (
        (
            outcome = 'ISSUED'
            AND amount_atomic IS NOT NULL
            AND referrer_reward_event_id IS NOT NULL
            AND referral_reward_event_id IS NOT NULL
            AND referral_edge_id IS NOT NULL
        )
        OR (
            outcome <> 'ISSUED'
            AND referrer_reward_event_id IS NULL
            AND referral_reward_event_id IS NULL
        )
    )
);

COMMENT ON TABLE referral_reward_decisions IS
    'Phase 15: one durable referral bonus decision per originating reward_event. '
    'Budget rejects are recorded so retries cannot invent a later-day bonus for the same source.';

CREATE INDEX IF NOT EXISTS referral_reward_decisions_edge_idx
    ON referral_reward_decisions (referral_edge_id, decided_at DESC)
    WHERE referral_edge_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_reject_referral_reward_decision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'referral_reward_decisions are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS referral_reward_decisions_reject_update ON referral_reward_decisions;
CREATE TRIGGER referral_reward_decisions_reject_update
    BEFORE UPDATE ON referral_reward_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_referral_reward_decision_mutation();

DROP TRIGGER IF EXISTS referral_reward_decisions_reject_delete ON referral_reward_decisions;
CREATE TRIGGER referral_reward_decisions_reject_delete
    BEFORE DELETE ON referral_reward_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_referral_reward_decision_mutation();

-- ---------------------------------------------------------------------------
-- Referral bonus exposure reservations (not tied to reward_quotes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS referral_bonus_exposure_reservations (
    id                       UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    source_reward_event_id   UUID NOT NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    referral_edge_id         UUID NOT NULL REFERENCES referral_edges (id) ON DELETE RESTRICT,
    exposure_period_id       UUID NOT NULL REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    amount_atomic            BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                    budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at              TIMESTAMPTZ NULL,
    consumed_at              TIMESTAMPTZ NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_bonus_exposure_reservations_source_key
        UNIQUE (source_reward_event_id),
    CONSTRAINT referral_bonus_exposure_reservations_period_key
        UNIQUE (source_reward_event_id, exposure_period_id),
    CONSTRAINT referral_bonus_exposure_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE referral_bonus_exposure_reservations IS
    'Phase 15: MAX_REFERRAL_BONUS_DAILY capacity reserved/consumed for a referral bonus. '
    'Not linked to reward_quotes — invitee quotes must never fund referrer exposure.';

CREATE INDEX IF NOT EXISTS referral_bonus_exposure_reservations_period_idx
    ON referral_bonus_exposure_reservations (exposure_period_id)
    WHERE state = 'ACTIVE';

CREATE TRIGGER referral_bonus_exposure_reservations_set_updated_at
    BEFORE UPDATE ON referral_bonus_exposure_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0047_phase15_referral_reward_issuance')
ON CONFLICT (version) DO NOTHING;

COMMIT;
