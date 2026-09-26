-- ALEx Rewards — Hot Wallet Jetton asset account type
-- 0029_hot_wallet_jetton_asset.sql
--
-- Scope (forward-only; migrations 0001–0028 remain byte-identical):
--   * Add HOT_WALLET_JETTON_ASSET for non-USDT Jetton hot-wallet inventory
--     (isolated Testnet aalex first). USDT continues to use HOT_WALLET_USDT_ASSET.
--
-- PostgreSQL note: ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL
-- 12+ (CI pins 18.6). IF NOT EXISTS keeps upgrades idempotent.

BEGIN;

ALTER TYPE ledger_account_type ADD VALUE IF NOT EXISTS 'HOT_WALLET_JETTON_ASSET';

INSERT INTO schema_migrations (version)
VALUES ('0029_hot_wallet_jetton_asset')
ON CONFLICT (version) DO NOTHING;

COMMIT;
