-- ALEx Rewards — Phase 10 targeted remediation S-05
-- 0027_signer_login_isolation.sql
--
-- Scope:
--   * Dedicated LOGIN role alex_rewards_signer inheriting alex_rewards_signer_ro.
--   * Minimum privileges for signer_withdrawal_attempt_signing_v only.
--   * No INSERT/UPDATE/DELETE/DDL on financial tables; no CREATEROLE/CREATEDB.
--
-- Password is NOT set here (no secrets in migrations). Local Docker / ops must
-- provision LOGIN password separately — see docs/SIGNER_DB_PRIVILEGE_ISOLATION.md.
-- Migrations 0001–0026 are unchanged.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alex_rewards_signer_ro') THEN
        CREATE ROLE alex_rewards_signer_ro NOLOGIN;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alex_rewards_signer') THEN
        CREATE ROLE alex_rewards_signer
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            INHERIT
            PASSWORD NULL;
    END IF;
END
$$;

COMMENT ON ROLE alex_rewards_signer IS
    'Phase 10 dedicated signer LOGIN. Inherits alex_rewards_signer_ro only. '
    'Must never be table owner / superuser. Password provisioned outside migrations.';

-- Ensure read-only grant role has only view SELECT (idempotent with 0020).
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

GRANT alex_rewards_signer_ro TO alex_rewards_signer;

-- Login role itself must not hold broader table grants than the RO role.
REVOKE ALL ON TABLE signer_withdrawal_attempt_signing_v FROM alex_rewards_signer;
GRANT SELECT ON TABLE signer_withdrawal_attempt_signing_v TO alex_rewards_signer;

REVOKE ALL ON TABLE withdrawals FROM alex_rewards_signer;
REVOKE ALL ON TABLE withdrawal_attempts FROM alex_rewards_signer;
REVOKE ALL ON TABLE withdrawal_approvals FROM alex_rewards_signer;
REVOKE ALL ON TABLE withdrawal_quotes FROM alex_rewards_signer;
REVOKE ALL ON TABLE ledger_entries FROM alex_rewards_signer;
REVOKE ALL ON TABLE ledger_transactions FROM alex_rewards_signer;
REVOKE ALL ON TABLE ledger_account_balances FROM alex_rewards_signer;
REVOKE ALL ON TABLE outbox_events FROM alex_rewards_signer;
REVOKE ALL ON TABLE blockchain_transactions FROM alex_rewards_signer;
REVOKE ALL ON TABLE hot_wallets FROM alex_rewards_signer;
REVOKE ALL ON TABLE review_cases FROM alex_rewards_signer;

-- Schema USAGE for SELECT on the view; CONNECT granted per-database by provisioner.
-- Revoke PUBLIC CREATE so inheriting sessions cannot DDL via public schema default grants.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO alex_rewards_signer;
GRANT USAGE ON SCHEMA public TO alex_rewards_signer_ro;
REVOKE CREATE ON SCHEMA public FROM alex_rewards_signer;
REVOKE CREATE ON SCHEMA public FROM alex_rewards_signer_ro;

-- Harden: login must not auto-inherit future grants intended for API/worker owners.
ALTER ROLE alex_rewards_signer NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

INSERT INTO schema_migrations (version)
VALUES ('0027_signer_login_isolation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
