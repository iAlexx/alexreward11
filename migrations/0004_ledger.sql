-- ALEx Rewards — Phase 2 Database Baseline
-- 0004_ledger.sql
--
-- Scope: the immutable double-entry ledger (spec §24, §94) plus its current
-- balance projection and historical snapshots.
--
-- Authority notes:
--   * ledger_entries and posted ledger_transactions are the financial source of
--     truth. Both reject UPDATE and DELETE at the database level.
--   * ledger_account_balances is a transactionally maintained projection that is
--     fully rebuildable from entries. It is never an independent source of truth.
--   * Corrections are new reversal transactions linked by reverses_transaction_id.
--     An original transaction is never mutated into a "reversed" status.
--   * This migration creates physical schema only. Posting behaviour lands in a
--     later phase.

BEGIN;

-- ---------------------------------------------------------------------------
-- Accounts (spec §94.1)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
    id            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    owner_type    ledger_owner_type NOT NULL,
    owner_id      UUID NULL,
    account_type  ledger_account_type NOT NULL,
    account_class ledger_account_class NOT NULL,
    normal_side   ledger_side NOT NULL,
    asset_id      UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    status        activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Required by spec §94.1: platform accounts have a NULL owner, and NULL must
    -- collide with NULL so a second platform account of the same type is rejected.
    CONSTRAINT ledger_accounts_identity_key
        UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, account_type, asset_id),
    CONSTRAINT ledger_accounts_owner_presence
        CHECK (
            (owner_type = 'PLATFORM' AND owner_id IS NULL)
            OR (owner_type <> 'PLATFORM' AND owner_id IS NOT NULL)
        )
);

COMMENT ON TABLE ledger_accounts IS
    'Chart of accounts. owner_id is polymorphic (users.id, hot_wallets.id, '
    'ad_providers.id) and therefore intentionally has no foreign key; ownership is '
    'resolved by owner_type.';
COMMENT ON COLUMN ledger_accounts.normal_side IS
    'Debit-normal balance = debits - credits. Credit-normal balance = credits - debits.';

CREATE INDEX ledger_accounts_owner_idx ON ledger_accounts (owner_type, owner_id);
CREATE INDEX ledger_accounts_type_asset_idx ON ledger_accounts (account_type, asset_id);

CREATE TRIGGER ledger_accounts_set_updated_at
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Transactions (spec §94.2)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_transactions (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    transaction_type       ledger_transaction_type NOT NULL,
    business_reference_type TEXT NOT NULL,
    business_reference_id  UUID NULL,
    idempotency_scope      TEXT NOT NULL,
    idempotency_key        TEXT NOT NULL,
    asset_id               UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    reverses_transaction_id UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
    posted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by_type        actor_type NOT NULL DEFAULT 'SYSTEM',
    created_by_id          UUID NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_transactions_idempotency_key
        UNIQUE (idempotency_scope, idempotency_key),
    -- One posted transaction per business reference and type (spec §104).
    CONSTRAINT ledger_transactions_business_reference_key
        UNIQUE NULLS NOT DISTINCT
            (transaction_type, business_reference_type, business_reference_id),
    CONSTRAINT ledger_transactions_no_self_reversal
        CHECK (reverses_transaction_id IS NULL OR reverses_transaction_id <> id)
);

COMMENT ON TABLE ledger_transactions IS
    'Immutable posted transaction headers. Exactly one asset per transaction and '
    'sum(debits) = sum(credits) across its entries.';

CREATE INDEX ledger_transactions_posted_at_idx ON ledger_transactions (posted_at DESC);
CREATE INDEX ledger_transactions_reverses_idx
    ON ledger_transactions (reverses_transaction_id)
    WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX ledger_transactions_business_reference_idx
    ON ledger_transactions (business_reference_type, business_reference_id);

CREATE TRIGGER ledger_transactions_reject_update
    BEFORE UPDATE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER ledger_transactions_reject_delete
    BEFORE DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Entries (spec §94.3)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_entries (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    ledger_account_id     UUID NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
    direction             ledger_side NOT NULL,
    amount_atomic         BIGINT NOT NULL CHECK (amount_atomic > 0),
    entry_index           SMALLINT NOT NULL DEFAULT 0 CHECK (entry_index >= 0),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_entries_transaction_index_key
        UNIQUE (ledger_transaction_id, entry_index)
);

COMMENT ON TABLE ledger_entries IS
    'Immutable double-entry lines. All amounts are positive atomic units; direction '
    'carries the sign. No UPDATE or DELETE is permitted after posting.';

CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (ledger_transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (ledger_account_id, created_at DESC);

CREATE TRIGGER ledger_entries_reject_update
    BEFORE UPDATE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER ledger_entries_reject_delete
    BEFORE DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Current balance projection (spec §94.4)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_account_balances (
    ledger_account_id         UUID PRIMARY KEY
                              REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
    balance_atomic            BIGINT NOT NULL DEFAULT 0,
    version                   BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    last_ledger_transaction_id UUID NULL
                              REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- balance_atomic is a signed projection: it may legitimately be zero, and the
-- non-negativity rule for user Pending/Available/Reserved liabilities is enforced
-- by the posting engine inside the same transaction, not by a column CHECK.
COMMENT ON TABLE ledger_account_balances IS
    'Transactionally maintained current-balance projection used for row locking and '
    'fast reads. Fully rebuildable from ledger_entries; never an independent truth.';

CREATE TRIGGER ledger_account_balances_set_updated_at
    BEFORE UPDATE ON ledger_account_balances
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Historical snapshots (spec §94.5)
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_balance_snapshots (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    ledger_account_id         UUID NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
    as_of                     TIMESTAMPTZ NOT NULL,
    balance_atomic            BIGINT NOT NULL,
    entry_count               BIGINT NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
    last_ledger_transaction_id UUID NULL
                              REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ledger_balance_snapshots_account_as_of_key UNIQUE (ledger_account_id, as_of)
);

COMMENT ON TABLE ledger_balance_snapshots IS
    'Performance/history projection only. Must remain rebuildable from ledger entries.';

CREATE INDEX ledger_balance_snapshots_as_of_idx ON ledger_balance_snapshots (as_of DESC);

-- ---------------------------------------------------------------------------
-- Deferred foreign keys from migration 0003
-- ---------------------------------------------------------------------------

ALTER TABLE reward_events
    ADD CONSTRAINT reward_events_ledger_transaction_fkey
        FOREIGN KEY (ledger_transaction_id)
        REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    ADD CONSTRAINT reward_events_maturity_ledger_transaction_fkey
        FOREIGN KEY (maturity_ledger_transaction_id)
        REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    ADD CONSTRAINT reward_events_reversal_ledger_transaction_fkey
        FOREIGN KEY (reversal_ledger_transaction_id)
        REFERENCES ledger_transactions (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (version)
VALUES ('0004_ledger')
ON CONFLICT (version) DO NOTHING;

COMMIT;
