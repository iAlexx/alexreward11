-- ALEx Rewards — Phase 10 TON Testnet payout foundation
-- 0021_phase10_broadcast_evidence.sql
--
-- Scope: additive nullable columns on withdrawal_attempts for pre-broadcast
-- evidence (signed external message BOC) and broadcast ambiguity tracking.
--
-- Migrations 0001–0020 are immutable. Intent immutability triggers from 0017
-- still apply to existing intent columns (withdrawal_id, attempt_number,
-- hot_wallet_id, expected_seqno, query_id, valid_until, canonical_message_hash,
-- signer_key_reference, dispatch_fencing_token, signing_started_at, created_at).
-- These new columns are lifecycle/evidence fields and may be updated.

BEGIN;

ALTER TABLE withdrawal_attempts
    ADD COLUMN IF NOT EXISTS signed_external_message_boc TEXT NULL,
    ADD COLUMN IF NOT EXISTS broadcast_submitted_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS broadcast_ambiguity_class TEXT NULL;

COMMENT ON COLUMN withdrawal_attempts.signed_external_message_boc IS
    'Base64 BOC of the signed external message retained BEFORE sendBoc for '
    'rebroadcast-safe reconcile. Pre-broadcast evidence only; signer never broadcasts.';

COMMENT ON COLUMN withdrawal_attempts.broadcast_submitted_at IS
    'Wall-clock when sendBoc was invoked (may still be UNKNOWN if RPC timed out). '
    'Once set, blind resend is forbidden until reconcile proves safety.';

COMMENT ON COLUMN withdrawal_attempts.broadcast_ambiguity_class IS
    'Classification when submit outcome is ambiguous, e.g. RPC_TIMEOUT, '
    'CRASH_AFTER_SUBMIT, PROVIDER_DISAGREE. NULL when not applicable.';

COMMENT ON TABLE withdrawal_attempts IS
    'Payout attempt rows. Intent fields remain immutable (0017 trigger). Phase 10 '
    'adds signed_external_message_boc / broadcast_submitted_at / broadcast_ambiguity_class '
    'as additive evidence for Testnet broadcast outside apps/signer.';

INSERT INTO schema_migrations (version)
VALUES ('0021_phase10_broadcast_evidence')
ON CONFLICT (version) DO NOTHING;

COMMIT;
