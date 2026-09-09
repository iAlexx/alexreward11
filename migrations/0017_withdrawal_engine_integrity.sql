-- ALEx Rewards — Phase 7 withdrawal engine integrity
-- 0017_withdrawal_engine_integrity.sql
--
-- Proven needs (do NOT edit 0001–0016):
--   * fee/limit ACTIVE overlap safety + financial-field immutability
--   * frozen withdrawal quote + withdrawal structural money/provenance
--   * fee/limit/membership entitlement provenance on quotes
--   * concurrency-safe gross volume periods/reservations
--   * durable payout reconciliation evidence (paid / non-paid / ambiguous)
--   * attempt intent-field immutability
--   * hot wallet identity frozen on withdrawal for volume reconstruction
--
-- Local/test fixtures may instantiate locked V1.2 initial fee/limit values at
-- runtime. Production rows remain explicitly provisioned — not seeded here.

BEGIN;

-- ---------------------------------------------------------------------------
-- Quote provenance (fee entitlement reconstruction + limit rule binding)
-- ---------------------------------------------------------------------------

ALTER TABLE withdrawal_quotes
    ADD COLUMN IF NOT EXISTS limit_rule_id UUID NULL REFERENCES withdrawal_limit_rules (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS base_platform_fee_atomic BIGINT NULL CHECK (base_platform_fee_atomic >= 0),
    ADD COLUMN IF NOT EXISTS user_membership_id UUID NULL REFERENCES user_memberships (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS fee_entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS priority_entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS priority_review BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN withdrawal_quotes.base_platform_fee_atomic IS
    'Phase 7: platform fee before membership discount. fee_amount_atomic is the final fee.';
COMMENT ON COLUMN withdrawal_quotes.fee_entitlement_rule_version_id IS
    'Phase 7: membership_benefit_rule_versions id for WITHDRAWAL_PLATFORM_FEE_DISCOUNT when applied.';
COMMENT ON COLUMN withdrawal_quotes.priority_entitlement_rule_version_id IS
    'Phase 7: membership_benefit_rule_versions id for PRIORITY_WITHDRAWAL_REVIEW when true.';

-- ---------------------------------------------------------------------------
-- Withdrawal provenance / reconcile durability
-- ---------------------------------------------------------------------------

ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS limit_rule_id UUID NULL REFERENCES withdrawal_limit_rules (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS fee_rule_id UUID NULL REFERENCES withdrawal_fee_rules (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS fee_rule_version INTEGER NULL,
    ADD COLUMN IF NOT EXISTS limit_rule_version INTEGER NULL,
    ADD COLUMN IF NOT EXISTS base_platform_fee_atomic BIGINT NULL CHECK (base_platform_fee_atomic >= 0),
    ADD COLUMN IF NOT EXISTS membership_fee_discount_bps INTEGER NULL
        CHECK (membership_fee_discount_bps IS NULL OR membership_fee_discount_bps BETWEEN 0 AND 10000),
    ADD COLUMN IF NOT EXISTS user_membership_id UUID NULL REFERENCES user_memberships (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS fee_entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS priority_entitlement_rule_version_id UUID NULL
        REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS hot_wallet_id UUID NULL REFERENCES hot_wallets (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS risk_policy_version INTEGER NULL,
    ADD COLUMN IF NOT EXISTS risk_decision withdrawal_risk_decision NULL,
    ADD COLUMN IF NOT EXISTS held_from_reconcile BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS reservation_ledger_tx_id UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS release_ledger_tx_id UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS settlement_ledger_tx_id UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT;

COMMENT ON COLUMN withdrawals.held_from_reconcile IS
    'Phase 7: true when HELD originated from RECONCILE_REQUIRED. REJECT/APPROVE forbidden until '
    'durable non-payment (or paid) reconciliation evidence exists.';
COMMENT ON COLUMN withdrawals.hot_wallet_id IS
    'Phase 7: Hot Wallet used for volume-limit authorization at REQUESTED; reconstructable later.';

-- ---------------------------------------------------------------------------
-- ACTIVE fee/limit overlap prevention (fail closed at DB)
-- ---------------------------------------------------------------------------

ALTER TABLE withdrawal_fee_rules
    DROP CONSTRAINT IF EXISTS withdrawal_fee_rules_active_overlap;

ALTER TABLE withdrawal_fee_rules
    ADD CONSTRAINT withdrawal_fee_rules_active_overlap
    EXCLUDE USING gist (
        asset_id WITH =,
        network_id WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
    )
    WHERE (status = 'ACTIVE');

ALTER TABLE withdrawal_limit_rules
    DROP CONSTRAINT IF EXISTS withdrawal_limit_rules_active_overlap;

ALTER TABLE withdrawal_limit_rules
    ADD CONSTRAINT withdrawal_limit_rules_active_overlap
    EXCLUDE USING gist (
        asset_id WITH =,
        network_id WITH =,
        risk_tier WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
    )
    WHERE (status = 'ACTIVE');

-- ---------------------------------------------------------------------------
-- Financial rule immutability (lifecycle status/valid_to/updated_at allowed)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_withdrawal_fee_rules_reject_financial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.network_id IS DISTINCT FROM OLD.network_id
        OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
        OR NEW.fixed_fee_atomic IS DISTINCT FROM OLD.fixed_fee_atomic
        OR NEW.percentage_bps IS DISTINCT FROM OLD.percentage_bps
        OR NEW.min_fee_atomic IS DISTINCT FROM OLD.min_fee_atomic
        OR NEW.max_fee_atomic IS DISTINCT FROM OLD.max_fee_atomic
    THEN
        RAISE EXCEPTION 'withdrawal_fee_rules financial fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_fee_rules_reject_financial_update ON withdrawal_fee_rules;
CREATE TRIGGER withdrawal_fee_rules_reject_financial_update
    BEFORE UPDATE ON withdrawal_fee_rules
    FOR EACH ROW EXECUTE FUNCTION app_withdrawal_fee_rules_reject_financial_update();

CREATE OR REPLACE FUNCTION app_withdrawal_limit_rules_reject_financial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.network_id IS DISTINCT FROM OLD.network_id
        OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
        OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
        OR NEW.min_withdrawal_atomic IS DISTINCT FROM OLD.min_withdrawal_atomic
        OR NEW.max_single_withdrawal_atomic IS DISTINCT FROM OLD.max_single_withdrawal_atomic
        OR NEW.max_user_hourly_atomic IS DISTINCT FROM OLD.max_user_hourly_atomic
        OR NEW.max_user_daily_atomic IS DISTINCT FROM OLD.max_user_daily_atomic
        OR NEW.max_hot_wallet_hourly_atomic IS DISTINCT FROM OLD.max_hot_wallet_hourly_atomic
        OR NEW.max_hot_wallet_daily_atomic IS DISTINCT FROM OLD.max_hot_wallet_daily_atomic
        OR NEW.max_auto_payout_atomic IS DISTINCT FROM OLD.max_auto_payout_atomic
        OR NEW.wallet_change_cooldown_seconds IS DISTINCT FROM OLD.wallet_change_cooldown_seconds
    THEN
        RAISE EXCEPTION 'withdrawal_limit_rules financial fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_limit_rules_reject_financial_update ON withdrawal_limit_rules;
CREATE TRIGGER withdrawal_limit_rules_reject_financial_update
    BEFORE UPDATE ON withdrawal_limit_rules
    FOR EACH ROW EXECUTE FUNCTION app_withdrawal_limit_rules_reject_financial_update();

-- ---------------------------------------------------------------------------
-- Frozen withdrawal quote (lifecycle only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_withdrawal_quotes_reject_financial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.network_id IS DISTINCT FROM OLD.network_id
        OR NEW.primary_wallet_id IS DISTINCT FROM OLD.primary_wallet_id
        OR NEW.requested_amount_atomic IS DISTINCT FROM OLD.requested_amount_atomic
        OR NEW.fee_amount_atomic IS DISTINCT FROM OLD.fee_amount_atomic
        OR NEW.net_amount_atomic IS DISTINCT FROM OLD.net_amount_atomic
        OR NEW.fee_rule_id IS DISTINCT FROM OLD.fee_rule_id
        OR NEW.fee_rule_version IS DISTINCT FROM OLD.fee_rule_version
        OR NEW.limit_rule_version IS DISTINCT FROM OLD.limit_rule_version
        OR NEW.limit_rule_id IS DISTINCT FROM OLD.limit_rule_id
        OR NEW.membership_fee_discount_bps IS DISTINCT FROM OLD.membership_fee_discount_bps
        OR NEW.base_platform_fee_atomic IS DISTINCT FROM OLD.base_platform_fee_atomic
        OR NEW.user_membership_id IS DISTINCT FROM OLD.user_membership_id
        OR NEW.fee_entitlement_rule_version_id IS DISTINCT FROM OLD.fee_entitlement_rule_version_id
        OR NEW.priority_entitlement_rule_version_id IS DISTINCT FROM OLD.priority_entitlement_rule_version_id
        OR NEW.priority_review IS DISTINCT FROM OLD.priority_review
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'withdrawal_quotes financial snapshot fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'OPEN' AND NEW.status IN ('CONSUMED', 'CANCELLED', 'EXPIRED'))
        ) THEN
            RAISE EXCEPTION 'withdrawal_quotes illegal status transition'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_quotes_reject_financial_update ON withdrawal_quotes;
CREATE TRIGGER withdrawal_quotes_reject_financial_update
    BEFORE UPDATE ON withdrawal_quotes
    FOR EACH ROW EXECUTE FUNCTION app_withdrawal_quotes_reject_financial_update();

-- ---------------------------------------------------------------------------
-- Withdrawal structural/financial immutability (state/timestamps/workflow ok)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_withdrawals_reject_financial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.withdrawal_quote_id IS DISTINCT FROM OLD.withdrawal_quote_id
        OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
        OR NEW.network_id IS DISTINCT FROM OLD.network_id
        OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
        OR NEW.requested_amount_atomic IS DISTINCT FROM OLD.requested_amount_atomic
        OR NEW.fee_amount_atomic IS DISTINCT FROM OLD.fee_amount_atomic
        OR NEW.net_amount_atomic IS DISTINCT FROM OLD.net_amount_atomic
        OR NEW.idempotency_scope IS DISTINCT FROM OLD.idempotency_scope
        OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
        OR NEW.public_id IS DISTINCT FROM OLD.public_id
        OR NEW.limit_rule_id IS DISTINCT FROM OLD.limit_rule_id
        OR NEW.fee_rule_id IS DISTINCT FROM OLD.fee_rule_id
        OR NEW.fee_rule_version IS DISTINCT FROM OLD.fee_rule_version
        OR NEW.limit_rule_version IS DISTINCT FROM OLD.limit_rule_version
        OR NEW.base_platform_fee_atomic IS DISTINCT FROM OLD.base_platform_fee_atomic
        OR NEW.membership_fee_discount_bps IS DISTINCT FROM OLD.membership_fee_discount_bps
        OR NEW.user_membership_id IS DISTINCT FROM OLD.user_membership_id
        OR NEW.fee_entitlement_rule_version_id IS DISTINCT FROM OLD.fee_entitlement_rule_version_id
        OR NEW.priority_entitlement_rule_version_id IS DISTINCT FROM OLD.priority_entitlement_rule_version_id
        OR NEW.priority_review IS DISTINCT FROM OLD.priority_review
        OR NEW.hot_wallet_id IS DISTINCT FROM OLD.hot_wallet_id
        OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'withdrawals financial/structural fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
    -- reservation_ledger_tx_id set-once
    IF OLD.reservation_ledger_tx_id IS NOT NULL
        AND NEW.reservation_ledger_tx_id IS DISTINCT FROM OLD.reservation_ledger_tx_id
    THEN
        RAISE EXCEPTION 'withdrawals.reservation_ledger_tx_id is set-once'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.release_ledger_tx_id IS NOT NULL
        AND NEW.release_ledger_tx_id IS DISTINCT FROM OLD.release_ledger_tx_id
    THEN
        RAISE EXCEPTION 'withdrawals.release_ledger_tx_id is set-once'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.settlement_ledger_tx_id IS NOT NULL
        AND NEW.settlement_ledger_tx_id IS DISTINCT FROM OLD.settlement_ledger_tx_id
    THEN
        RAISE EXCEPTION 'withdrawals.settlement_ledger_tx_id is set-once'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawals_reject_financial_update ON withdrawals;
CREATE TRIGGER withdrawals_reject_financial_update
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW EXECUTE FUNCTION app_withdrawals_reject_financial_update();

-- ---------------------------------------------------------------------------
-- Attempt intent immutability
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_withdrawal_attempts_reject_intent_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id
        OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.hot_wallet_id IS DISTINCT FROM OLD.hot_wallet_id
        OR NEW.expected_seqno IS DISTINCT FROM OLD.expected_seqno
        OR NEW.query_id IS DISTINCT FROM OLD.query_id
        OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
        OR NEW.canonical_message_hash IS DISTINCT FROM OLD.canonical_message_hash
        OR NEW.signer_key_reference IS DISTINCT FROM OLD.signer_key_reference
        OR NEW.dispatch_fencing_token IS DISTINCT FROM OLD.dispatch_fencing_token
        OR NEW.signing_started_at IS DISTINCT FROM OLD.signing_started_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'withdrawal_attempts intent fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
    -- once broadcast may have started, cannot set FAILED_PRE_BROADCAST (also CHECK)
    IF NEW.broadcast_started_at IS NOT NULL
        AND OLD.broadcast_started_at IS NULL
        AND NEW.broadcast_result_state = 'FAILED_PRE_BROADCAST'
    THEN
        RAISE EXCEPTION 'FAILED_PRE_BROADCAST impossible after possible broadcast'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_attempts_reject_intent_update ON withdrawal_attempts;
CREATE TRIGGER withdrawal_attempts_reject_intent_update
    BEFORE UPDATE ON withdrawal_attempts
    FOR EACH ROW EXECUTE FUNCTION app_withdrawal_attempts_reject_intent_update();

-- ---------------------------------------------------------------------------
-- Gross volume periods + reservations (user + hot wallet, hour + UTC day)
-- ---------------------------------------------------------------------------

CREATE TYPE withdrawal_volume_scope AS ENUM (
    'USER_HOURLY',
    'USER_UTC_DAY',
    'HOT_WALLET_HOURLY',
    'HOT_WALLET_UTC_DAY'
);

CREATE TABLE withdrawal_volume_periods (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    scope              withdrawal_volume_scope NOT NULL,
    asset_id           UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    network_id         UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    user_id            UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
    hot_wallet_id      UUID NULL REFERENCES hot_wallets (id) ON DELETE RESTRICT,
    period_start       TIMESTAMPTZ NOT NULL,
    period_end         TIMESTAMPTZ NOT NULL,
    consumed_atomic    BIGINT NOT NULL DEFAULT 0 CHECK (consumed_atomic >= 0),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_volume_periods_window CHECK (period_end > period_start),
    CONSTRAINT withdrawal_volume_periods_subject_consistent CHECK (
        (scope IN ('USER_HOURLY', 'USER_UTC_DAY') AND user_id IS NOT NULL AND hot_wallet_id IS NULL)
        OR (scope IN ('HOT_WALLET_HOURLY', 'HOT_WALLET_UTC_DAY') AND hot_wallet_id IS NOT NULL AND user_id IS NULL)
    )
);

CREATE UNIQUE INDEX withdrawal_volume_periods_user_key
    ON withdrawal_volume_periods (scope, asset_id, network_id, user_id, period_start)
    WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX withdrawal_volume_periods_hot_wallet_key
    ON withdrawal_volume_periods (scope, asset_id, network_id, hot_wallet_id, period_start)
    WHERE hot_wallet_id IS NOT NULL;

CREATE TRIGGER withdrawal_volume_periods_set_updated_at
    BEFORE UPDATE ON withdrawal_volume_periods
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE withdrawal_volume_reservations (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    volume_period_id      UUID NOT NULL REFERENCES withdrawal_volume_periods (id) ON DELETE RESTRICT,
    withdrawal_id         UUID NOT NULL REFERENCES withdrawals (id) ON DELETE RESTRICT,
    amount_atomic         BIGINT NOT NULL CHECK (amount_atomic > 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_volume_reservations_unique
        UNIQUE (volume_period_id, withdrawal_id)
);

COMMENT ON TABLE withdrawal_volume_periods IS
    'Phase 7: PostgreSQL-authoritative gross request volume counters. Redis has zero authority. '
    'Committed REQUESTED withdrawals consume volume for the original UTC period permanently.';

COMMENT ON TABLE withdrawal_volume_reservations IS
    'Phase 7: per-withdrawal volume consumption evidence. Idempotent retries must not double-count.';

-- ---------------------------------------------------------------------------
-- Durable fake-chain / payout reconciliation evidence (per withdrawal)
-- ---------------------------------------------------------------------------

CREATE TYPE withdrawal_payout_reconcile_resolution AS ENUM (
    'UNRESOLVED',
    'INTENDED_PAYOUT_PROVEN',
    'DEFINITIVE_NONPAYMENT',
    'AMBIGUOUS'
);

CREATE TABLE withdrawal_payout_reconciliations (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    withdrawal_id             UUID NOT NULL REFERENCES withdrawals (id) ON DELETE RESTRICT,
    withdrawal_attempt_id     UUID NULL REFERENCES withdrawal_attempts (id) ON DELETE RESTRICT,
    resolution                withdrawal_payout_reconcile_resolution NOT NULL DEFAULT 'UNRESOLVED',
    evidence_summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_recipient        TEXT NULL,
    observed_amount_atomic    BIGINT NULL,
    observed_asset_symbol     TEXT NULL,
    observed_query_id         BIGINT NULL,
    correlation_reference     TEXT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at               TIMESTAMPTZ NULL,
    CONSTRAINT withdrawal_payout_reconciliations_resolution_time
        CHECK (
            (resolution = 'UNRESOLVED' AND resolved_at IS NULL)
            OR (resolution <> 'UNRESOLVED' AND resolved_at IS NOT NULL)
        )
);

CREATE INDEX withdrawal_payout_reconciliations_withdrawal_idx
    ON withdrawal_payout_reconciliations (withdrawal_id, created_at DESC);

CREATE TRIGGER withdrawal_payout_reconciliations_reject_update
    BEFORE UPDATE ON withdrawal_payout_reconciliations
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER withdrawal_payout_reconciliations_reject_delete
    BEFORE DELETE ON withdrawal_payout_reconciliations
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

COMMENT ON TABLE withdrawal_payout_reconciliations IS
    'Phase 7: append-only durable payout reconciliation evidence. DEFINITIVE_NONPAYMENT is '
    'required before reject from reconcile-origin HELD. Never silently edits ledger history.';

INSERT INTO schema_migrations (version)
VALUES ('0017_withdrawal_engine_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
