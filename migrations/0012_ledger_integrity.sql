-- ALEx Rewards — Phase 4 Ledger Core
-- 0012_ledger_integrity.sql
--
-- Scope: financial integrity fixes discovered while implementing Ledger Core.
-- Does NOT edit 0004_ledger.sql.
--
-- Fixes:
--   1. At-most-one direct reversal per original transaction
--      (UNIQUE on non-null reverses_transaction_id).
--   2. Structural fields on ledger_accounts become immutable after insert
--      so historical interpretation cannot be corrupted by identity mutation.
--      Lifecycle field `status` (and updated_at) may still change.

BEGIN;

-- One economic reversal row may point at a given original transaction.
-- Concurrent double-reversal races fail at the database, not only in app code.
CREATE UNIQUE INDEX ledger_transactions_one_reversal_per_original_idx
    ON ledger_transactions (reverses_transaction_id)
    WHERE reverses_transaction_id IS NOT NULL;

COMMENT ON INDEX ledger_transactions_one_reversal_per_original_idx IS
    'Phase 4: at most one direct reversal transaction per original (V1.2 correction = new linked tx).';

CREATE OR REPLACE FUNCTION app_reject_ledger_account_structural_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.owner_type IS DISTINCT FROM NEW.owner_type
        OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
        OR OLD.account_type IS DISTINCT FROM NEW.account_type
        OR OLD.account_class IS DISTINCT FROM NEW.account_class
        OR OLD.normal_side IS DISTINCT FROM NEW.normal_side
        OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    THEN
        RAISE EXCEPTION
            'ledger_accounts structural fields are immutable (owner/type/class/side/asset)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_reject_ledger_account_structural_mutation() IS
    'Phase 4: rejects financially structural mutations on ledger_accounts. '
    'status/updated_at remain mutable for lifecycle.';

CREATE TRIGGER ledger_accounts_reject_structural_update
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW
    EXECUTE FUNCTION app_reject_ledger_account_structural_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0012_ledger_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
