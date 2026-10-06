-- ALEx Rewards Phase 21
-- 0059_phase21_manual_dispatch_permits.sql
-- One-shot Owner-armed Mainnet manual dispatch permits.
-- Authorization evidence only — not ledger truth. Additive. No seeds. No money.
--
-- Also recreates signer_withdrawal_attempt_signing_v so PAYOUT_DISPATCH_PAUSE
-- remains globally true while an attempt-scoped Phase 21 manual-permit exception
-- waives pause ONLY for the exact bound withdrawal_attempt (never a permanent
-- withdrawal-level CONSUMED bypass).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'phase21_manual_dispatch_permit_status'
  ) THEN
    CREATE TYPE phase21_manual_dispatch_permit_status AS ENUM (
      'ARMED',
      'CONSUMED',
      'CANCELLED'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS phase21_manual_dispatch_permits (
  id UUID PRIMARY KEY,
  withdrawal_id UUID NOT NULL REFERENCES withdrawals (id),
  public_id TEXT NOT NULL,
  authorized_gross_atomic BIGINT NOT NULL,
  authorized_fee_atomic BIGINT NOT NULL,
  authorized_net_atomic BIGINT NOT NULL,
  authorized_recipient_friendly TEXT NOT NULL,
  authorized_recipient_raw TEXT NOT NULL,
  authorized_network_code TEXT NOT NULL,
  authorized_asset_symbol TEXT NOT NULL,
  authorized_jetton_master TEXT NOT NULL,
  authorized_attached_gram_atomic BIGINT NOT NULL,
  authorized_forward_gram_atomic BIGINT NOT NULL,
  status phase21_manual_dispatch_permit_status NOT NULL,
  -- One-shot bind: set atomically when the first immutable withdrawal_attempt is created.
  -- CONSUMED without consumed_attempt_id is rejected by constraint (fail closed).
  consumed_attempt_id UUID NULL REFERENCES withdrawal_attempts (id),
  created_by_admin_user_id UUID NOT NULL REFERENCES admin_users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  cancel_reason TEXT NULL,
  idempotency_key TEXT NOT NULL,
  audit_correlation_id TEXT NULL,
  CONSTRAINT phase21_manual_dispatch_permits_withdrawal_unique UNIQUE (withdrawal_id),
  CONSTRAINT phase21_manual_dispatch_permits_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT phase21_manual_dispatch_permits_amounts_chk CHECK (
    authorized_gross_atomic = authorized_fee_atomic + authorized_net_atomic
    AND authorized_net_atomic > 0
    AND authorized_fee_atomic >= 0
    AND authorized_attached_gram_atomic >= 0
    AND authorized_forward_gram_atomic >= 0
  ),
  CONSTRAINT phase21_manual_dispatch_permits_status_times_chk CHECK (
    (
      status = 'ARMED'::phase21_manual_dispatch_permit_status
      AND consumed_at IS NULL
      AND cancelled_at IS NULL
      AND consumed_attempt_id IS NULL
    )
    OR (
      status = 'CONSUMED'::phase21_manual_dispatch_permit_status
      AND consumed_at IS NOT NULL
      AND cancelled_at IS NULL
      AND consumed_attempt_id IS NOT NULL
    )
    OR (
      status = 'CANCELLED'::phase21_manual_dispatch_permit_status
      AND cancelled_at IS NOT NULL
      AND consumed_attempt_id IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS phase21_manual_dispatch_permits_status_idx
  ON phase21_manual_dispatch_permits (status);

COMMENT ON TABLE phase21_manual_dispatch_permits IS
  'Phase 21 Owner-armed one-shot Mainnet manual dispatch authorization. Not financial truth. CONSUMED binds to exactly one withdrawal_attempt / dispatch generation; never a permanent pause bypass.';

COMMENT ON COLUMN phase21_manual_dispatch_permits.consumed_attempt_id IS
  'Immutable attempt id bound at first withdrawal_attempt creation. CONSUMED may resume/reconcile only this attempt; never authorize a fresh attempt.';

-- Recreate signer view (2023 shape) with attempt-scoped Phase 21 permit exception.
DROP VIEW IF EXISTS signer_withdrawal_attempt_signing_v;
CREATE VIEW signer_withdrawal_attempt_signing_v AS
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
  (
    EXISTS (
      SELECT 1
      FROM feature_flags ff
      WHERE ff.flag_key = 'PAYOUT_DISPATCH_PAUSE'
        AND ff.enabled = true
    )
    AND NOT EXISTS (
      SELECT 1
      FROM phase21_manual_dispatch_permits p
      WHERE p.withdrawal_id = w.id
        AND p.status = 'CONSUMED'::phase21_manual_dispatch_permit_status
        AND p.consumed_attempt_id = a.id
    )
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

COMMENT ON VIEW signer_withdrawal_attempt_signing_v IS
  'Signer read boundary: attempt signing fields + withdrawal-scoped Phase 21 manual-permit pause exception (CONSUMED bound to THIS attempt only).';

REVOKE ALL ON TABLE signer_withdrawal_attempt_signing_v FROM PUBLIC;
GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer;
REVOKE ALL ON TABLE signer_withdrawal_attempt_signing_v FROM alex_rewards_signer;
GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer;

INSERT INTO schema_migrations (version)
VALUES ('0059_phase21_manual_dispatch_permits')
ON CONFLICT (version) DO NOTHING;

COMMIT;
