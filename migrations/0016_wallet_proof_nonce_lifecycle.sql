-- ALEx Rewards — Phase 6 wallet proof nonce lifecycle
-- 0016_wallet_proof_nonce_lifecycle.sql
--
-- Necessity: V1.2 §29 requires pending old-wallet challenges to be invalidated when
-- the primary wallet changes. consumed_at alone cannot distinguish successful
-- CONSUMED vs SECURITY_INVALIDATED without corrupting audit semantics.
-- Does NOT edit migrations 0001–0015.

BEGIN;

ALTER TABLE user_wallet_proof_nonces
    ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS invalidation_reason TEXT NULL;

ALTER TABLE user_wallet_proof_nonces
    DROP CONSTRAINT IF EXISTS user_wallet_proof_nonces_terminal_exclusive;

ALTER TABLE user_wallet_proof_nonces
    ADD CONSTRAINT user_wallet_proof_nonces_terminal_exclusive
    CHECK (
        NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)
    );

ALTER TABLE user_wallet_proof_nonces
    DROP CONSTRAINT IF EXISTS user_wallet_proof_nonces_invalidation_consistent;

ALTER TABLE user_wallet_proof_nonces
    ADD CONSTRAINT user_wallet_proof_nonces_invalidation_consistent
    CHECK (
        (invalidated_at IS NULL AND invalidation_reason IS NULL)
        OR (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
    );

COMMENT ON COLUMN user_wallet_proof_nonces.invalidated_at IS
    'Phase 6: set when a still-open challenge is security-invalidated (e.g. primary wallet change). '
    'Distinct from consumed_at, which records successful proof consumption.';

COMMENT ON COLUMN user_wallet_proof_nonces.invalidation_reason IS
    'Phase 6: narrow reason code such as PRIMARY_WALLET_CHANGED. Never stores raw nonce material.';

DROP INDEX IF EXISTS user_wallet_proof_nonces_open_idx;
CREATE INDEX user_wallet_proof_nonces_open_idx
    ON user_wallet_proof_nonces (user_id, network_id, expires_at)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0016_wallet_proof_nonce_lifecycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
