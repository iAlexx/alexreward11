-- ALEx Rewards — Phase 10 External-In message identity evidence
-- 0022_external_message_identity.sql
--
-- Additive only: migrations 0001–0021 remain immutable. These nullable evidence
-- columns distinguish the signed Wallet request body from the final External-In
-- message and its cell/normalized identities. They are persisted before sendBoc.

BEGIN;

ALTER TABLE withdrawal_attempts
    ADD COLUMN IF NOT EXISTS signed_wallet_request_boc TEXT NULL,
    ADD COLUMN IF NOT EXISTS external_message_cell_hash TEXT NULL,
    ADD COLUMN IF NOT EXISTS normalized_external_message_hash TEXT NULL;

COMMENT ON COLUMN withdrawal_attempts.signed_wallet_request_boc IS
    'Base64 BOC of the signed Wallet V5 R1 request body; not a broadcastable message.';

COMMENT ON COLUMN withdrawal_attempts.external_message_cell_hash IS
    'Lowercase hex hash of the exact final External-In message cell persisted before sendBoc.';

COMMENT ON COLUMN withdrawal_attempts.normalized_external_message_hash IS
    'Lowercase hex Tonkeeper-normalized External-In hash used for chain identity and lookup.';

COMMENT ON COLUMN withdrawal_attempts.signed_message_hash IS
    'Deprecated compatibility alias of normalized_external_message_hash; never SHA256(signature).';

INSERT INTO schema_migrations (version)
VALUES ('0022_external_message_identity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
