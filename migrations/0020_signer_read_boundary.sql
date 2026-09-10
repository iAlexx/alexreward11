-- ALEx Rewards — Phase 9 TON Testnet Signer Spike
-- 0020_signer_read_boundary.sql
--
-- Scope:
--   * hot_wallets.payout_jetton_wallet_address — deployment-controlled USDT Jetton
--     wallet snapshot for the Hot Wallet owner (no TON RPC inside signer).
--   * Narrow read-only VIEW for signer independent validation.
--   * DB role alex_rewards_signer_ro with SELECT-only privilege on the view.
--
-- Does NOT store seeds/private keys. Does NOT add broadcast/chain-provider tables.
-- Migrations 0001–0019 are unchanged.

BEGIN;

ALTER TABLE hot_wallets
    ADD COLUMN payout_jetton_wallet_address TEXT NULL;

COMMENT ON COLUMN hot_wallets.payout_jetton_wallet_address IS
    'Phase 9+: deployment-controlled USDT Jetton wallet contract address for this Hot Wallet '
    'owner on the Hot Wallet network. Required for real signer USDT payouts. Never derived via '
    'TON RPC inside apps/signer. NULL until provisioned.';

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
    ) AS payout_dispatch_paused
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

COMMENT ON VIEW signer_withdrawal_attempt_signing_v IS
    'Phase 9 narrow read model for apps/signer. SELECT-only. Exposes one attempt joining '
    'withdrawal, approval, hot wallet, network, asset, quote and lease fields required to '
    'independently reconstruct canonical TON signable intent. No private key material.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alex_rewards_signer_ro') THEN
        CREATE ROLE alex_rewards_signer_ro NOLOGIN;
    END IF;
END
$$;

COMMENT ON ROLE alex_rewards_signer_ro IS
    'Phase 9 signer read-only DB identity. Must never hold INSERT/UPDATE/DELETE/DDL on '
    'financial/domain tables. Login users inherit this role in staging/production.';

REVOKE ALL ON TABLE signer_withdrawal_attempt_signing_v FROM PUBLIC;
GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer_ro;

REVOKE ALL ON TABLE withdrawals FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE withdrawal_attempts FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE withdrawal_approvals FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE withdrawal_quotes FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE ledger_entries FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE ledger_transactions FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE ledger_account_balances FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE outbox_events FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE blockchain_transactions FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE hot_wallets FROM alex_rewards_signer_ro;
REVOKE ALL ON TABLE review_cases FROM alex_rewards_signer_ro;

INSERT INTO schema_migrations (version)
VALUES ('0020_signer_read_boundary')
ON CONFLICT (version) DO NOTHING;

COMMIT;
