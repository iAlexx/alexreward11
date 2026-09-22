-- ALEx Rewards — M1 Option C remediation PR-02
-- 0028_owner_bootstrap_attempt_nonce_attempt_wide.sql
--
-- Scope (isolated / forward-only):
--   Attempt-wide uniqueness for channel proof nonces.
--   PRIMARY KEY becomes (attempt_id, nonce_hex) so the same nonce_hex cannot be
--   reused across channel_pop / channel_cred / channel_abort on one attempt.
--   purpose remains an audited column with the existing CHECK constraint.
--   Signature domain separation (distinct signed byte layouts per purpose) is unchanged.
--
-- Does NOT apply to operational DBs by this workstream; migrateDatabase on
-- alex_rewards_test (and future approved ops migrate) applies it.

BEGIN;

ALTER TABLE owner_bootstrap_attempt_nonces
    DROP CONSTRAINT owner_bootstrap_attempt_nonces_pkey;

ALTER TABLE owner_bootstrap_attempt_nonces
    ADD CONSTRAINT owner_bootstrap_attempt_nonces_pkey
    PRIMARY KEY (attempt_id, nonce_hex);

COMMENT ON TABLE owner_bootstrap_attempt_nonces IS
    'One-time channel proof nonces per attempt (nonce_hex unique attempt-wide across purposes). Does not prevent first-use of a stolen complete request.';

INSERT INTO schema_migrations (version)
VALUES ('0028_owner_bootstrap_attempt_nonce_attempt_wide')
ON CONFLICT (version) DO NOTHING;

COMMIT;
