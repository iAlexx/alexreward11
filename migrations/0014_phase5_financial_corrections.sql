-- ALEx Rewards — Phase 5 financial corrections
-- 0014_phase5_financial_corrections.sql
--
-- Scope: runtime integrity gaps found after Phase 5 acceptance review.
-- Does NOT edit migrations 0001–0013.
--
-- Exact necessity:
--   1. Authoritative simulated_reward_sources registration (Outbox alone is insufficient).
--   2. Database protection for frozen reward_quotes financial snapshot fields.
--   3. Multi-period membership bonus reservations per quote (one row per period).
--   4. Atomic economic exposure period counters + per-quote reservations for
--      concurrency-safe guardrail authorization.
--
-- Upgrade: apply on top of an accepted 0013 database.
-- Clean-from-zero: included after 0013 in migrations/*.sql order.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Simulated reward source registry (server-authoritative)
-- ---------------------------------------------------------------------------

CREATE TABLE simulated_reward_sources (
    id              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id     UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    user_id         UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
    status          TEXT NOT NULL DEFAULT 'CREATED'
                    CHECK (status IN ('CREATED', 'QUOTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    quoted_at       TIMESTAMPTZ NULL,
    completed_at    TIMESTAMPTZ NULL,
    cancelled_at    TIMESTAMPTZ NULL,
    CONSTRAINT simulated_reward_sources_quoted_requires_time
        CHECK (status <> 'QUOTED' OR quoted_at IS NOT NULL),
    CONSTRAINT simulated_reward_sources_completed_requires_time
        CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);

COMMENT ON TABLE simulated_reward_sources IS
    'Phase 5: server-controlled simulated monetary source identities. '
    'Quotes may only bind PROMOTION source_id values that exist here and remain eligible. '
    'Never accepts client monetary amounts. Provider must be SIMULATED_REWARD_SOURCE / BLOCKED.';

CREATE INDEX simulated_reward_sources_provider_status_idx
    ON simulated_reward_sources (provider_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Frozen reward_quotes financial snapshot protection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_reject_reward_quote_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.source_type IS DISTINCT FROM NEW.source_type
        OR OLD.source_id IS DISTINCT FROM NEW.source_id
        OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
        OR OLD.ad_unit_id IS DISTINCT FROM NEW.ad_unit_id
        OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
        OR OLD.reward_rule_id IS DISTINCT FROM NEW.reward_rule_id
        OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
        OR OLD.base_amount_atomic IS DISTINCT FROM NEW.base_amount_atomic
        OR OLD.membership_bonus_amount_atomic IS DISTINCT FROM NEW.membership_bonus_amount_atomic
        OR OLD.amount_atomic IS DISTINCT FROM NEW.amount_atomic
        OR OLD.membership_id IS DISTINCT FROM NEW.membership_id
        OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
        OR OLD.applied_economics IS DISTINCT FROM NEW.applied_economics
        OR OLD.bonus_unavailable_policy IS DISTINCT FROM NEW.bonus_unavailable_policy
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'reward_quotes financial snapshot fields are immutable after insert'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- source_started_at: NULL -> timestamp exactly once; never rewrite once set.
    IF OLD.source_started_at IS NOT NULL
        AND NEW.source_started_at IS DISTINCT FROM OLD.source_started_at
    THEN
        RAISE EXCEPTION
            'reward_quotes.source_started_at cannot be rewritten after it is set'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_reward_quote_financial_mutation() IS
    'Phase 5 correction: protects frozen quote economics. Allowed lifecycle: status, '
    'source_started_at NULL→once, consumed_at, cancelled_at, updated_at.';

DROP TRIGGER IF EXISTS reward_quotes_reject_financial_update ON reward_quotes;
CREATE TRIGGER reward_quotes_reject_financial_update
    BEFORE UPDATE ON reward_quotes
    FOR EACH ROW
    EXECUTE FUNCTION app_reject_reward_quote_financial_mutation();

-- ---------------------------------------------------------------------------
-- 3. Multi-scope membership bonus reservations (one row per budget period/quote)
-- ---------------------------------------------------------------------------

ALTER TABLE membership_bonus_budget_reservations
    DROP CONSTRAINT IF EXISTS membership_bonus_budget_reservations_quote_key;

ALTER TABLE membership_bonus_budget_reservations
    DROP CONSTRAINT IF EXISTS membership_bonus_budget_reservations_origin_key;

ALTER TABLE membership_bonus_budget_reservations
    DROP CONSTRAINT IF EXISTS membership_bonus_budget_reservations_bonus_key;

CREATE UNIQUE INDEX membership_bonus_budget_reservations_quote_period_key
    ON membership_bonus_budget_reservations (reward_quote_id, budget_period_id)
    WHERE reward_quote_id IS NOT NULL;

CREATE UNIQUE INDEX membership_bonus_budget_reservations_origin_period_key
    ON membership_bonus_budget_reservations (originating_reward_event_id, budget_period_id)
    WHERE originating_reward_event_id IS NOT NULL;

CREATE UNIQUE INDEX membership_bonus_budget_reservations_bonus_period_key
    ON membership_bonus_budget_reservations (bonus_reward_event_id, budget_period_id)
    WHERE bonus_reward_event_id IS NOT NULL;

COMMENT ON INDEX membership_bonus_budget_reservations_quote_period_key IS
    'Phase 5 correction: one reservation per (quote, bonus budget period) so daily/monthly/'
    'plan/user/global caps can all be reserved atomically for the same quote.';

-- ---------------------------------------------------------------------------
-- 4. Economic exposure period counters + per-quote reservations
-- ---------------------------------------------------------------------------

CREATE TABLE economic_exposure_periods (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    exposure_limit_id   UUID NOT NULL REFERENCES economic_exposure_limits (id) ON DELETE RESTRICT,
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    limit_atomic        BIGINT NOT NULL CHECK (limit_atomic > 0),
    reserved_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
    consumed_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (consumed_atomic >= 0),
    released_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (released_atomic >= 0),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT economic_exposure_periods_limit_window_key
        UNIQUE (exposure_limit_id, period_start),
    CONSTRAINT economic_exposure_periods_window CHECK (period_end > period_start),
    CONSTRAINT economic_exposure_periods_projection_bounded
        CHECK (reserved_atomic + consumed_atomic <= limit_atomic)
);

COMMENT ON TABLE economic_exposure_periods IS
    'Phase 5 correction: time-scoped atomic exposure counters for ACTIVE economic_exposure_limits. '
    'Usage is reserved/consumed/released under row locks; Redis has zero authority.';

CREATE TRIGGER economic_exposure_periods_set_updated_at
    BEFORE UPDATE ON economic_exposure_periods
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE economic_exposure_reservations (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    reward_quote_id      UUID NOT NULL REFERENCES reward_quotes (id) ON DELETE RESTRICT,
    exposure_period_id   UUID NOT NULL REFERENCES economic_exposure_periods (id) ON DELETE RESTRICT,
    amount_atomic        BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at          TIMESTAMPTZ NULL,
    consumed_at          TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT economic_exposure_reservations_quote_period_key
        UNIQUE (reward_quote_id, exposure_period_id),
    CONSTRAINT economic_exposure_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE economic_exposure_reservations IS
    'Phase 5 correction: per-quote exposure reservations tied to economic_exposure_periods. '
    'Released on pre-start quote expiry; consumed on successful reward issuance.';

CREATE INDEX economic_exposure_reservations_quote_idx
    ON economic_exposure_reservations (reward_quote_id);

CREATE TRIGGER economic_exposure_reservations_set_updated_at
    BEFORE UPDATE ON economic_exposure_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0014_phase5_financial_corrections')
ON CONFLICT (version) DO NOTHING;

COMMIT;
