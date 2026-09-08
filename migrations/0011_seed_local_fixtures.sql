-- ALEx Rewards — Phase 2 Database Baseline
-- 0011_seed_local_fixtures.sql
--
-- LOCAL FIXTURE ONLY. Everything inserted by this migration is local/test
-- reference data for development and automated tests.
--
-- This file MUST NOT contain:
--   * production or mainnet identifiers of any kind
--   * the real mainnet USDT Jetton master address
--   * secrets, credentials, bot tokens, chat IDs or signer references
--   * production financial values (reward economics, fees, limits, budgets,
--     Founder bonus rates) — those are OWNER_DECISION_REQUIRED and are created
--     as approved, audited rule versions at runtime, never seeded here
--
-- All inserts are idempotent so a seeded database can be re-migrated safely.

BEGIN;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — TON testnet network
-- ---------------------------------------------------------------------------

INSERT INTO networks (
    code, chain, environment, display_name, global_chain_identifier,
    public_explorer_base_url, status
)
VALUES (
    'TON_TESTNET',
    'TON',
    'TESTNET',
    'TON Testnet (LOCAL FIXTURE ONLY)',
    'ton:testnet',
    'https://testnet.tonviewer.com/',
    'ACTIVE'
)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — placeholder testnet USDT asset
--
-- contract_identity is a deliberately invalid placeholder string. The controlled
-- testnet Jetton master and the allowlisted mainnet USDT Jetton master are
-- deployment-controlled configuration and remain production blockers.
-- ---------------------------------------------------------------------------

INSERT INTO assets (network_id, symbol, name, decimals, is_native, contract_identity, status)
SELECT
    n.id,
    'USDT',
    'Tether USD (LOCAL FIXTURE ONLY placeholder)',
    6,
    false,
    'LOCAL-TESTONLY-PLACEHOLDER-USDT-JETTON-MASTER',
    'ACTIVE'
FROM networks AS n
WHERE n.code = 'TON_TESTNET'
ON CONFLICT (network_id, symbol, contract_identity) DO NOTHING;

-- LOCAL FIXTURE ONLY — native TON, used for gas accounting in local tests.
INSERT INTO assets (network_id, symbol, name, decimals, is_native, contract_identity, status)
SELECT
    n.id,
    'TON',
    'Toncoin (LOCAL FIXTURE ONLY)',
    9,
    true,
    NULL,
    'ACTIVE'
FROM networks AS n
WHERE n.code = 'TON_TESTNET'
ON CONFLICT (network_id, symbol, contract_identity) DO NOTHING;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — membership plans
--
-- FOUNDER_LIFETIME is a membership/benefit product only: no equity, no ownership
-- share, no debt instrument, no guaranteed return and no promise to recover the
-- purchase price. The 50 USD figure below is the locked catalogue price from the
-- specification (5000 atomic units at 2 decimals), not a financial obligation of
-- the platform.
-- ---------------------------------------------------------------------------

INSERT INTO membership_plans (
    code, name, billing_model, price_currency, price_decimals, price_atomic, is_lifetime, status
)
VALUES
    ('STANDARD', 'Standard', 'FREE', NULL, NULL, NULL, false, 'ACTIVE'),
    ('FOUNDER_LIFETIME', 'ALEx Rewards Founder', 'ONE_TIME', 'USD', 2, 5000, true, 'ACTIVE')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — entitlement definitions
--
-- These rows define the typed benefit vocabulary only. They carry NO values.
-- Concrete benefit values (for example a Founder reward bonus in bps) live in
-- membership_benefit_rule_versions and require explicit Owner approval, so they
-- are intentionally not seeded.
-- ---------------------------------------------------------------------------

INSERT INTO entitlements (code, name, value_type, security_classification, description)
VALUES
    ('FOUNDER_BADGE', 'Founder badge', 'BOOLEAN', 'PUBLIC',
     'Displays the Founder badge on user surfaces.'),
    ('FOUNDER_NUMBER', 'Founder number', 'INTEGER', 'PUBLIC',
     'Permanent sequential Founder number bound to the membership.'),
    ('ELIGIBLE_REWARD_BONUS', 'Eligible reward bonus', 'BPS', 'FINANCIAL',
     'Platform-funded bonus in bps applied to explicitly eligible rewards.'),
    ('REFERRAL_RATE_BOOST', 'Referral rate boost', 'BPS', 'FINANCIAL',
     'Effective referral rate profile in bps; the invitee reward is never reduced.'),
    ('WITHDRAWAL_PLATFORM_FEE_DISCOUNT', 'Withdrawal platform fee discount', 'BPS', 'FINANCIAL',
     'Discount in bps on the platform withdrawal fee. Network fees are never hidden.'),
    ('PRIORITY_WITHDRAWAL_REVIEW', 'Priority withdrawal review', 'BOOLEAN', 'INTERNAL',
     'Queue priority only; never bypasses risk, cooldown, liquidity or signer rules.'),
    ('PRIORITY_SUPPORT', 'Priority support', 'BOOLEAN', 'INTERNAL',
     'Raises support ticket priority.'),
    ('EXCLUSIVE_MISSION_ACCESS', 'Exclusive mission access', 'BOOLEAN', 'INTERNAL',
     'Grants access to membership-restricted missions.'),
    ('FOUNDER_COMPETITION_ACCESS', 'Founder competition access', 'BOOLEAN', 'INTERNAL',
     'Grants access to Founder competitions.'),
    ('EARLY_FEATURE_ACCESS', 'Early feature access', 'BOOLEAN', 'INTERNAL',
     'Enables early access to approved features.')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — RBAC vocabulary
--
-- Roles and permissions are structural, not financial. Only OWNER is enabled in
-- V1. No admin user, credential, recovery code or session is seeded.
-- ---------------------------------------------------------------------------

INSERT INTO admin_roles (code, name, description, status)
VALUES
    ('OWNER', 'Owner', 'Full administrative authority. The only enabled V1 role.', 'ACTIVE'),
    ('FINANCE', 'Finance', 'Financial review and reporting. Not enabled in V1.', 'DISABLED'),
    ('SUPPORT', 'Support', 'User support operations. Not enabled in V1.', 'DISABLED'),
    ('FRAUD_ANALYST', 'Fraud analyst', 'Fraud and risk review. Not enabled in V1.', 'DISABLED'),
    ('CAMPAIGN_MANAGER', 'Campaign manager', 'Campaign operations. Not enabled in V1.', 'DISABLED')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- LOCAL FIXTURE ONLY — local feature flag defaults
--
-- Every flag is seeded disabled for the LOCAL environment. Enabling a flag is an
-- audited change recorded in feature_flag_versions.
-- ---------------------------------------------------------------------------

INSERT INTO feature_flags (flag_key, environment, enabled, description)
VALUES
    ('GLOBAL_REWARDS_PAUSE', 'LOCAL', false, 'Kill switch: pause all reward issuance.'),
    ('WITHDRAWAL_REQUESTS_PAUSE', 'LOCAL', false, 'Kill switch: pause new withdrawal requests.'),
    ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', false, 'Kill switch: pause payout dispatch.'),
    ('AUTO_PAYOUT_PAUSE', 'LOCAL', false, 'Kill switch: pause automatic payouts.'),
    ('MEMBERSHIP_BONUS_PAUSE', 'LOCAL', false, 'Kill switch: pause membership bonus issuance.'),
    ('REFERRAL_REWARD_PAUSE', 'LOCAL', false, 'Kill switch: pause referral rewards.'),
    ('MISSION_REWARD_PAUSE', 'LOCAL', false, 'Kill switch: pause mission rewards.'),
    ('WALLET_VERIFICATION_PAUSE', 'LOCAL', false, 'Kill switch: pause wallet verification.'),
    ('PUBLIC_PAYOUT_LOGS_ENABLED', 'LOCAL', false, 'Publish confirmed payouts publicly.'),
    ('KYC_ENABLED', 'LOCAL', false, 'KYC is disabled in V1.')
ON CONFLICT (flag_key, environment) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0011_seed_local_fixtures')
ON CONFLICT (version) DO NOTHING;

COMMIT;
