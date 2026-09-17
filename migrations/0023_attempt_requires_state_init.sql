-- Phase 10: persist proven-account StateInit requirement on payout attempts.
-- StateInit must follow dual-provider uninitialized admission, not seqno=0 alone.

BEGIN;

ALTER TABLE withdrawal_attempts
    ADD COLUMN requires_state_init BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN withdrawal_attempts.requires_state_init IS
    'True only when dual-provider account-state admission proved the Hot Wallet uninitialized '
    '(first External-In must include Wallet V5R1 StateInit). Active wallets, including '
    'active+seqno=0, must remain false.';

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
        OR NEW.requires_state_init IS DISTINCT FROM OLD.requires_state_init
        OR NEW.signing_started_at IS DISTINCT FROM OLD.signing_started_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'withdrawal_attempts intent fields are immutable after insert'
            USING ERRCODE = 'check_violation';
    END IF;
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

-- Append-only column on REPLACE VIEW (PostgreSQL forbids mid-list rename/reorder).
CREATE OR REPLACE VIEW signer_withdrawal_attempt_signing_v AS
SELECT
    a.id AS withdrawal_attempt_id,
    a.withdrawal_id,
    a.attempt_number,
    a.hot_wallet_id,
    a.expected_seqno,
    a.query_id,
    a.valid_until,
    a.canonical_message_hash,
    a.signed_message_hash,
    a.signer_key_reference,
    a.dispatch_fencing_token,
    a.broadcast_result_state,
    a.signing_started_at,
    a.broadcast_started_at,
    a.settled_at,
    a.created_at AS attempt_created_at,
    w.public_id AS withdrawal_public_id,
    w.user_id,
    w.state AS withdrawal_state,
    w.asset_id,
    w.network_id,
    w.wallet_id AS recipient_wallet_id,
    w.requested_amount_atomic,
    w.fee_amount_atomic,
    w.net_amount_atomic,
    w.approved_at,
    w.held_at,
    w.rejected_at,
    w.confirmed_at,
    uw.raw_address AS recipient_raw_address,
    uw.friendly_address AS recipient_friendly_address,
    uw.verified AS recipient_wallet_verified,
    uw.disabled_at AS recipient_wallet_disabled_at,
    hw.address AS hot_wallet_address,
    hw.friendly_address AS hot_wallet_friendly_address,
    hw.wallet_version AS hot_wallet_version,
    hw.signer_type AS hot_wallet_signer_type,
    hw.signer_reference AS hot_wallet_signer_reference,
    hw.status AS hot_wallet_status,
    hw.payout_jetton_wallet_address,
    n.code AS network_code,
    n.chain AS network_chain,
    n.environment AS network_environment,
    n.global_chain_identifier,
    n.status AS network_status,
    ast.symbol AS asset_symbol,
    ast.decimals AS asset_decimals,
    ast.is_native AS asset_is_native,
    ast.contract_identity AS asset_contract_identity,
    ast.status AS asset_status,
    q.requested_amount_atomic AS quote_requested_amount_atomic,
    q.fee_amount_atomic AS quote_fee_amount_atomic,
    q.net_amount_atomic AS quote_net_amount_atomic,
    ap.id AS approval_id,
    ap.decision AS approval_decision,
    ap.decision_source AS approval_decision_source,
    ap.created_at AS approval_created_at,
    lease.fencing_token AS current_dispatch_fencing_token,
    lease.expires_at AS dispatch_lease_expires_at,
    lease.released_at AS dispatch_lease_released_at,
    EXISTS (
        SELECT 1
        FROM feature_flags ff
        WHERE ff.flag_key = 'PAYOUT_DISPATCH_PAUSE'
          AND ff.enabled = true
    ) AS payout_dispatch_paused,
    a.requires_state_init
FROM withdrawal_attempts a
INNER JOIN withdrawals w ON w.id = a.withdrawal_id
INNER JOIN user_wallets uw ON uw.id = w.wallet_id
INNER JOIN hot_wallets hw ON hw.id = a.hot_wallet_id
INNER JOIN networks n ON n.id = w.network_id
INNER JOIN assets ast ON ast.id = w.asset_id
INNER JOIN withdrawal_quotes q ON q.id = w.withdrawal_quote_id
LEFT JOIN LATERAL (
    SELECT wa.id, wa.decision, wa.decision_source, wa.created_at
    FROM withdrawal_approvals wa
    WHERE wa.withdrawal_id = w.id
      AND wa.decision = 'APPROVE'
    ORDER BY wa.created_at DESC
    LIMIT 1
) ap ON true
LEFT JOIN hot_wallet_dispatch_leases lease ON lease.hot_wallet_id = hw.id;

INSERT INTO schema_migrations (version)
VALUES ('0023_attempt_requires_state_init')
ON CONFLICT (version) DO NOTHING;

COMMIT;
