-- ALEx Rewards — Phase 2 Database Baseline
-- 0005_withdrawals_and_hot_wallet.sql
--
-- Scope: versioned withdrawal fee/limit rules, withdrawal quotes, withdrawals,
-- approvals, signing/broadcast attempts, blockchain correlation, hot wallets,
-- balance snapshots, chain observations and dispatch leases.
--
-- Authority notes:
--   * Money movement itself is ledger-only. These tables hold business state.
--   * No seed, private key or signing material is ever stored in PostgreSQL.
--   * Fee/limit values are versioned configuration rows. Launch numbers remain
--     OWNER_DECISION_REQUIRED and are deliberately NOT baked into CHECKs.
--   * Admin foreign keys are attached in migration 0007.

BEGIN;

-- ---------------------------------------------------------------------------
-- Versioned fee and limit rules (spec §38, §95.0, §112)
-- ---------------------------------------------------------------------------

CREATE TABLE withdrawal_fee_rules (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    asset_id             UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    network_id           UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    rule_version         INTEGER NOT NULL CHECK (rule_version > 0),
    fixed_fee_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (fixed_fee_atomic >= 0),
    percentage_bps       INTEGER NOT NULL DEFAULT 0 CHECK (percentage_bps BETWEEN 0 AND 10000),
    min_fee_atomic       BIGINT NULL CHECK (min_fee_atomic >= 0),
    max_fee_atomic       BIGINT NULL CHECK (max_fee_atomic >= 0),
    status               rule_version_status NOT NULL DEFAULT 'DRAFT',
    valid_from           TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to             TIMESTAMPTZ NULL,
    reason               TEXT NULL,
    source_reference     TEXT NULL,
    created_by_admin_id  UUID NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_fee_rules_version_key UNIQUE (asset_id, network_id, rule_version),
    CONSTRAINT withdrawal_fee_rules_valid_window
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT withdrawal_fee_rules_min_max_order
        CHECK (min_fee_atomic IS NULL OR max_fee_atomic IS NULL OR max_fee_atomic >= min_fee_atomic)
);

COMMENT ON TABLE withdrawal_fee_rules IS
    'Immutable versioned withdrawal fee rules. Consumed quotes pin fee_rule_version so a '
    'later fee change never mutates an existing valid quote.';

CREATE INDEX withdrawal_fee_rules_active_idx
    ON withdrawal_fee_rules (asset_id, network_id, valid_from DESC)
    WHERE status = 'ACTIVE';

CREATE TRIGGER withdrawal_fee_rules_set_updated_at
    BEFORE UPDATE ON withdrawal_fee_rules
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE withdrawal_limit_rules (
    id                              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    asset_id                        UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    network_id                      UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    rule_version                    INTEGER NOT NULL CHECK (rule_version > 0),
    risk_tier                       risk_tier NULL,
    -- All limits are measured on the gross requested amount, before fee (spec §38).
    min_withdrawal_atomic           BIGINT NOT NULL CHECK (min_withdrawal_atomic > 0),
    max_single_withdrawal_atomic    BIGINT NOT NULL CHECK (max_single_withdrawal_atomic > 0),
    max_user_hourly_atomic          BIGINT NOT NULL CHECK (max_user_hourly_atomic > 0),
    max_user_daily_atomic           BIGINT NOT NULL CHECK (max_user_daily_atomic > 0),
    max_hot_wallet_hourly_atomic    BIGINT NOT NULL CHECK (max_hot_wallet_hourly_atomic > 0),
    max_hot_wallet_daily_atomic     BIGINT NOT NULL CHECK (max_hot_wallet_daily_atomic > 0),
    max_auto_payout_atomic          BIGINT NULL CHECK (max_auto_payout_atomic > 0),
    wallet_change_cooldown_seconds  INTEGER NOT NULL CHECK (wallet_change_cooldown_seconds >= 0),
    status                          rule_version_status NOT NULL DEFAULT 'DRAFT',
    valid_from                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to                        TIMESTAMPTZ NULL,
    reason                          TEXT NULL,
    created_by_admin_id             UUID NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_limit_rules_version_key
        UNIQUE NULLS NOT DISTINCT (asset_id, network_id, risk_tier, rule_version),
    CONSTRAINT withdrawal_limit_rules_valid_window
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT withdrawal_limit_rules_single_within_daily
        CHECK (max_single_withdrawal_atomic <= max_user_daily_atomic),
    CONSTRAINT withdrawal_limit_rules_min_below_single
        CHECK (min_withdrawal_atomic <= max_single_withdrawal_atomic)
);

COMMENT ON TABLE withdrawal_limit_rules IS
    'Versioned gross withdrawal limits (user, hot wallet, auto-payout ceiling). '
    'Production launch values require Owner approval and live in data, not code.';

CREATE TRIGGER withdrawal_limit_rules_set_updated_at
    BEFORE UPDATE ON withdrawal_limit_rules
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Hot wallets (spec §32, §95.6, §95.9)
-- ---------------------------------------------------------------------------

CREATE TABLE hot_wallets (
    id               UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    network_id       UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    address          TEXT NOT NULL,
    friendly_address TEXT NULL,
    wallet_version   TEXT NOT NULL,
    signer_type      hot_wallet_signer_type NOT NULL,
    signer_reference TEXT NOT NULL,
    status           hot_wallet_status NOT NULL DEFAULT 'ACTIVE',
    label            TEXT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at       TIMESTAMPTZ NULL,
    CONSTRAINT hot_wallets_address_key UNIQUE (network_id, address)
);

COMMENT ON TABLE hot_wallets IS
    'Dedicated payout wallets. signer_reference is an external KMS/HSM key identifier; '
    'no seed phrase or private key material is ever stored here (spec §34).';

CREATE TRIGGER hot_wallets_set_updated_at
    BEFORE UPDATE ON hot_wallets
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE hot_wallet_dispatch_leases (
    hot_wallet_id  UUID PRIMARY KEY REFERENCES hot_wallets (id) ON DELETE CASCADE,
    owner_identity TEXT NOT NULL,
    fencing_token  BIGINT NOT NULL CHECK (fencing_token > 0),
    acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    renewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    released_at    TIMESTAMPTZ NULL,
    CONSTRAINT hot_wallet_dispatch_leases_window CHECK (expires_at > acquired_at)
);

COMMENT ON TABLE hot_wallet_dispatch_leases IS
    'Exactly one dispatch lease per hot wallet. Attempt creation and advancement '
    'require the current fencing token (spec §95.9).';

-- ---------------------------------------------------------------------------
-- Withdrawal quotes (spec §95.1)
-- ---------------------------------------------------------------------------

CREATE TABLE withdrawal_quotes (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                 UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    asset_id                UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    network_id              UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    primary_wallet_id       UUID NOT NULL REFERENCES user_wallets (id) ON DELETE RESTRICT,
    requested_amount_atomic BIGINT NOT NULL CHECK (requested_amount_atomic > 0),
    fee_amount_atomic       BIGINT NOT NULL CHECK (fee_amount_atomic >= 0),
    net_amount_atomic       BIGINT NOT NULL CHECK (net_amount_atomic > 0),
    fee_rule_id             UUID NOT NULL REFERENCES withdrawal_fee_rules (id) ON DELETE RESTRICT,
    fee_rule_version        INTEGER NOT NULL,
    limit_rule_version      INTEGER NULL,
    membership_fee_discount_bps INTEGER NOT NULL DEFAULT 0
                            CHECK (membership_fee_discount_bps BETWEEN 0 AND 10000),
    status                  withdrawal_quote_status NOT NULL DEFAULT 'OPEN',
    expires_at              TIMESTAMPTZ NOT NULL,
    consumed_at             TIMESTAMPTZ NULL,
    cancelled_at            TIMESTAMPTZ NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_quotes_amount_split
        CHECK (requested_amount_atomic = fee_amount_atomic + net_amount_atomic),
    CONSTRAINT withdrawal_quotes_expiry_after_creation CHECK (expires_at > created_at)
);

COMMENT ON TABLE withdrawal_quotes IS
    'Quote lifecycle is separate from the withdrawal row. A withdrawal exists only once a '
    'valid quote is consumed and gross funds are atomically reserved (spec §95.1).';
COMMENT ON COLUMN withdrawal_quotes.fee_amount_atomic IS
    'May be zero when a membership fee-waiver entitlement applies; net must stay positive.';

CREATE INDEX withdrawal_quotes_user_status_idx
    ON withdrawal_quotes (user_id, status, created_at DESC);
CREATE INDEX withdrawal_quotes_open_expiry_idx
    ON withdrawal_quotes (expires_at)
    WHERE status = 'OPEN';

CREATE TRIGGER withdrawal_quotes_set_updated_at
    BEFORE UPDATE ON withdrawal_quotes
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Withdrawals (spec §39, §40, §95.2)
-- ---------------------------------------------------------------------------

-- Public reference sequence (spec §103). Never a security boundary.
CREATE SEQUENCE withdrawal_public_id_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE TABLE withdrawals (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    public_id               TEXT NOT NULL
                            DEFAULT 'WD-' || lpad(nextval('withdrawal_public_id_seq')::text, 6, '0'),
    user_id                 UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    withdrawal_quote_id     UUID NOT NULL REFERENCES withdrawal_quotes (id) ON DELETE RESTRICT,
    asset_id                UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    network_id              UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    wallet_id               UUID NOT NULL REFERENCES user_wallets (id) ON DELETE RESTRICT,
    requested_amount_atomic BIGINT NOT NULL CHECK (requested_amount_atomic > 0),
    fee_amount_atomic       BIGINT NOT NULL CHECK (fee_amount_atomic >= 0),
    net_amount_atomic       BIGINT NOT NULL CHECK (net_amount_atomic > 0),
    state                   withdrawal_state NOT NULL DEFAULT 'REQUESTED',
    -- Foreign key attached in 0006 once risk_snapshots exists.
    risk_snapshot_id        UUID NULL,
    approval_policy_version INTEGER NOT NULL DEFAULT 1,
    priority_review         BOOLEAN NOT NULL DEFAULT false,
    idempotency_scope       TEXT NOT NULL,
    idempotency_key         TEXT NOT NULL,
    workflow_id             TEXT NULL,
    requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at             TIMESTAMPTZ NULL,
    queued_at               TIMESTAMPTZ NULL,
    broadcasted_at          TIMESTAMPTZ NULL,
    confirmed_at            TIMESTAMPTZ NULL,
    held_at                 TIMESTAMPTZ NULL,
    rejected_at             TIMESTAMPTZ NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawals_public_id_key UNIQUE (public_id),
    -- A quote can be consumed exactly once (spec §95.2).
    CONSTRAINT withdrawals_quote_key UNIQUE (withdrawal_quote_id),
    CONSTRAINT withdrawals_idempotency_key UNIQUE (idempotency_scope, idempotency_key),
    CONSTRAINT withdrawals_workflow_key UNIQUE (workflow_id),
    CONSTRAINT withdrawals_amount_split
        CHECK (requested_amount_atomic = fee_amount_atomic + net_amount_atomic)
);

COMMENT ON TABLE withdrawals IS
    'Created at REQUESTED inside the transaction that consumes the quote and moves gross '
    'funds Available -> Reserved. Ordinary user cancellation is unsupported after that.';
COMMENT ON COLUMN withdrawals.priority_review IS
    'Founder/priority queue placement only. It never bypasses risk, cooldown, liquidity, '
    'legal, signer or reconciliation rules (spec §156A.4).';
COMMENT ON COLUMN withdrawals.workflow_id IS
    'Deterministic Temporal workflow id withdrawal/{withdrawalId} (spec §105).';

CREATE INDEX withdrawals_user_state_idx ON withdrawals (user_id, state, requested_at DESC);
CREATE INDEX withdrawals_state_requested_idx ON withdrawals (state, requested_at);
CREATE INDEX withdrawals_open_review_idx
    ON withdrawals (priority_review DESC, requested_at)
    WHERE state IN ('REQUESTED', 'RISK_CHECK', 'MANUAL_REVIEW', 'HELD', 'RECONCILE_REQUIRED');

CREATE TRIGGER withdrawals_set_updated_at
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Approvals (spec §95.3)
-- ---------------------------------------------------------------------------

CREATE TABLE withdrawal_approvals (
    id              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    withdrawal_id   UUID NOT NULL REFERENCES withdrawals (id) ON DELETE RESTRICT,
    decision        withdrawal_decision NOT NULL,
    admin_id        UUID NULL,
    decision_source actor_source NOT NULL,
    reason          TEXT NULL,
    policy_version  INTEGER NULL,
    action_token_id UUID NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_approvals_manual_requires_admin
        CHECK (decision_source = 'AUTO_POLICY' OR admin_id IS NOT NULL)
);

COMMENT ON TABLE withdrawal_approvals IS
    'Immutable approval/hold/reject history. Web and Telegram decisions call the same '
    'backend command and land here identically (spec §41).';

CREATE INDEX withdrawal_approvals_withdrawal_idx
    ON withdrawal_approvals (withdrawal_id, created_at DESC);

CREATE TRIGGER withdrawal_approvals_reject_update
    BEFORE UPDATE ON withdrawal_approvals
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER withdrawal_approvals_reject_delete
    BEFORE DELETE ON withdrawal_approvals
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Signing / broadcast attempts (spec §46, §95.4)
-- ---------------------------------------------------------------------------

CREATE TABLE withdrawal_attempts (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    withdrawal_id             UUID NOT NULL REFERENCES withdrawals (id) ON DELETE RESTRICT,
    attempt_number            INTEGER NOT NULL CHECK (attempt_number > 0),
    hot_wallet_id             UUID NOT NULL REFERENCES hot_wallets (id) ON DELETE RESTRICT,
    expected_seqno            BIGINT NOT NULL CHECK (expected_seqno >= 0),
    query_id                  BIGINT NOT NULL,
    valid_until               TIMESTAMPTZ NOT NULL,
    canonical_message_hash    TEXT NOT NULL,
    signed_message_hash       TEXT NULL,
    signer_key_reference      TEXT NOT NULL,
    dispatch_fencing_token    BIGINT NOT NULL CHECK (dispatch_fencing_token > 0),
    broadcast_result_state    withdrawal_attempt_result NOT NULL DEFAULT 'PENDING',
    provider_response_redacted JSONB NULL,
    chain_reference           TEXT NULL,
    signing_started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    broadcast_started_at      TIMESTAMPTZ NULL,
    settled_at                TIMESTAMPTZ NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_attempts_number_key UNIQUE (withdrawal_id, attempt_number),
    CONSTRAINT withdrawal_attempts_query_id_key UNIQUE (hot_wallet_id, query_id),
    -- Spec §95.4: once broadcast may have started, FAILED_PRE_BROADCAST is impossible.
    CONSTRAINT withdrawal_attempts_pre_broadcast_consistent
        CHECK (broadcast_result_state <> 'FAILED_PRE_BROADCAST' OR broadcast_started_at IS NULL)
);

COMMENT ON TABLE withdrawal_attempts IS
    'Immutable-by-policy payout attempt facts: expected seqno, query id, canonical message '
    'hash, signer reference and dispatch fencing token.';

-- At most one live attempt per withdrawal.
CREATE UNIQUE INDEX withdrawal_attempts_one_active_idx
    ON withdrawal_attempts (withdrawal_id)
    WHERE broadcast_result_state IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED');

CREATE INDEX withdrawal_attempts_hot_wallet_idx
    ON withdrawal_attempts (hot_wallet_id, created_at DESC);

CREATE TRIGGER withdrawal_attempts_set_updated_at
    BEFORE UPDATE ON withdrawal_attempts
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Blockchain correlation (spec §44, §47, §95.5)
-- ---------------------------------------------------------------------------

CREATE TABLE blockchain_transactions (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    network_id             UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    hot_wallet_id          UUID NOT NULL REFERENCES hot_wallets (id) ON DELETE RESTRICT,
    withdrawal_attempt_id  UUID NULL REFERENCES withdrawal_attempts (id) ON DELETE RESTRICT,
    recipient_wallet_id    UUID NULL REFERENCES user_wallets (id) ON DELETE SET NULL,
    asset_id               UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    chain_tx_reference     TEXT NOT NULL,
    seqno_expected         BIGINT NULL,
    seqno_observed         BIGINT NULL,
    recipient_address      TEXT NOT NULL,
    jetton_master_address  TEXT NULL,
    amount_atomic          BIGINT NOT NULL CHECK (amount_atomic > 0),
    query_id               BIGINT NULL,
    state                  blockchain_transaction_state NOT NULL DEFAULT 'OBSERVED',
    raw_chain_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at           TIMESTAMPTZ NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT blockchain_transactions_reference_key UNIQUE (network_id, chain_tx_reference),
    CONSTRAINT blockchain_transactions_attempt_key UNIQUE (withdrawal_attempt_id)
);

COMMENT ON TABLE blockchain_transactions IS
    'Correlated on-chain payout record. One withdrawal attempt maps to at most one '
    'traceable transfer; V1 never batches payouts (spec §33).';

CREATE INDEX blockchain_transactions_state_idx ON blockchain_transactions (state, first_seen_at);

CREATE TRIGGER blockchain_transactions_set_updated_at
    BEFORE UPDATE ON blockchain_transactions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE chain_observations (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    network_id              UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    source_provider         TEXT NOT NULL,
    hot_wallet_id           UUID NULL REFERENCES hot_wallets (id) ON DELETE SET NULL,
    blockchain_transaction_id UUID NULL REFERENCES blockchain_transactions (id) ON DELETE SET NULL,
    block_reference         TEXT NULL,
    trace_reference         TEXT NULL,
    message_hash            TEXT NULL,
    seqno                   BIGINT NULL,
    query_id                BIGINT NULL,
    recipient_address       TEXT NULL,
    jetton_master_address   TEXT NULL,
    amount_atomic           BIGINT NULL CHECK (amount_atomic > 0),
    execution_result        TEXT NULL,
    raw_summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at             TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chain_observations_provider_observation_key
        UNIQUE NULLS NOT DISTINCT (network_id, source_provider, message_hash, seqno, query_id)
);

COMMENT ON TABLE chain_observations IS
    'Append-only observations from the primary and independent secondary TON providers. '
    'Used for confirmation and reconciliation; never mutated after insert.';

CREATE INDEX chain_observations_correlation_idx
    ON chain_observations (network_id, query_id, seqno);
CREATE INDEX chain_observations_observed_at_idx ON chain_observations (observed_at DESC);

CREATE TRIGGER chain_observations_reject_update
    BEFORE UPDATE ON chain_observations
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER chain_observations_reject_delete
    BEFORE DELETE ON chain_observations
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Hot wallet balance snapshots (spec §36, §95.7)
-- ---------------------------------------------------------------------------

CREATE TABLE hot_wallet_snapshots (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    hot_wallet_id         UUID NOT NULL REFERENCES hot_wallets (id) ON DELETE CASCADE,
    usdt_atomic           BIGINT NOT NULL CHECK (usdt_atomic >= 0),
    ton_atomic            BIGINT NOT NULL CHECK (ton_atomic >= 0),
    chain_height_marker   TEXT NULL,
    source_provider       TEXT NOT NULL,
    observed_at           TIMESTAMPTZ NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT hot_wallet_snapshots_observation_key
        UNIQUE (hot_wallet_id, source_provider, observed_at)
);

COMMENT ON TABLE hot_wallet_snapshots IS
    'Observed hot wallet liquidity used for coverage monitoring and alert thresholds. '
    'Threshold values are configuration, not schema constants.';

CREATE INDEX hot_wallet_snapshots_recent_idx
    ON hot_wallet_snapshots (hot_wallet_id, observed_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('0005_withdrawals_and_hot_wallet')
ON CONFLICT (version) DO NOTHING;

COMMIT;
