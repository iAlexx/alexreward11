-- ALEx Rewards — Phase 2 Database Baseline
-- 0001_extensions_enums.sql
--
-- Scope: extensions, shared helper functions, migration bookkeeping and every
-- PostgreSQL ENUM type used by the Phase 2 schema. No business engines here.
--
-- Conventions used by every Phase 2 migration:
--   * money is BIGINT in atomic units, column suffix `_atomic`
--   * amounts that must be positive carry CHECK (... > 0); balances may be zero
--   * there is never a mutable authoritative `users.balance` column
--   * primary keys are UUID DEFAULT app_generate_uuid()
--   * timestamps are TIMESTAMPTZ NOT NULL DEFAULT now() where a value always exists

BEGIN;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- pgcrypto: gen_random_uuid() fallback plus digest()/hmac() helpers for hashed
-- secrets stored by later phases.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- btree_gist: required for the EXCLUDE constraints that stop overlapping
-- versioned provider limit / country rules (migration 0009).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_migrations IS
    'Applied explicit SQL migration versions. Owned by the migration runner only.';

-- ---------------------------------------------------------------------------
-- Shared helper functions
-- ---------------------------------------------------------------------------

-- Identifier strategy (spec §103): sortable UUIDv7 preferred. PostgreSQL 18
-- ships uuidv7() natively; older servers fall back to gen_random_uuid() so the
-- baseline stays portable. Every table uses app_generate_uuid() as its default.
DO $bootstrap$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE proname = 'uuidv7'
          AND pronamespace = 'pg_catalog'::regnamespace
    ) THEN
        EXECUTE 'CREATE OR REPLACE FUNCTION app_generate_uuid() RETURNS uuid '
             || 'LANGUAGE sql VOLATILE PARALLEL SAFE '
             || 'AS $body$ SELECT pg_catalog.uuidv7() $body$';
    ELSE
        EXECUTE 'CREATE OR REPLACE FUNCTION app_generate_uuid() RETURNS uuid '
             || 'LANGUAGE sql VOLATILE PARALLEL SAFE '
             || 'AS $body$ SELECT gen_random_uuid() $body$';
    END IF;
END
$bootstrap$;

COMMENT ON FUNCTION app_generate_uuid() IS
    'Primary key generator: pg_catalog.uuidv7() when available, else gen_random_uuid().';

CREATE OR REPLACE FUNCTION app_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_set_updated_at() IS
    'BEFORE UPDATE trigger that maintains updated_at.';

CREATE OR REPLACE FUNCTION app_reject_row_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'table %.% is append-only; % is rejected',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION app_reject_row_mutation() IS
    'Guard trigger for append-only/immutable tables (ledger, audit, evidence).';

-- ---------------------------------------------------------------------------
-- Generic enums shared across domains
-- ---------------------------------------------------------------------------

-- Deployment environment for environment-scoped configuration rows.
CREATE TYPE environment_name AS ENUM ('LOCAL', 'DEV', 'STAGING', 'PRODUCTION');

-- Lifecycle of every versioned, effective-dated domain rule (spec §112, §156C).
CREATE TYPE rule_version_status AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVOKED');

-- Lifecycle of authored content (rules definitions, missions, tasks).
CREATE TYPE content_status AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- Simple on/off lifecycle for reference rows.
CREATE TYPE activation_status AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE severity_level AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE priority_level AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- Where a privileged action originated (spec §55, §95.3).
CREATE TYPE actor_source AS ENUM ('WEB', 'TELEGRAM', 'SYSTEM', 'API', 'AUTO_POLICY');

CREATE TYPE actor_type AS ENUM ('USER', 'ADMIN', 'SYSTEM', 'WORKER');

-- ---------------------------------------------------------------------------
-- Users, sessions, wallets
-- ---------------------------------------------------------------------------

-- Spec §10. Account access state, kept separate from withdrawal access.
CREATE TYPE user_status AS ENUM (
    'ACTIVE',
    'LIMITED',
    'SUSPENDED',
    'BANNED',
    'DELETED_ANONYMIZED'
);

CREATE TYPE user_withdrawal_access_status AS ENUM ('ALLOWED', 'RESTRICTED', 'BLOCKED');

-- Spec §77 risk bands.
CREATE TYPE risk_tier AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- Spec §119. KYC is disabled in V1; the schema stays KYC-ready.
CREATE TYPE kyc_status AS ENUM ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- Spec §50 public payout log identity preference.
CREATE TYPE public_payout_identity_mode AS ENUM ('SHOW_USERNAME', 'HIDE_IDENTITY');

CREATE TYPE session_revocation_reason AS ENUM (
    'USER_LOGOUT',
    'ROTATED',
    'EXPIRED',
    'ADMIN_REVOKED',
    'SECURITY_EVENT'
);

CREATE TYPE wallet_verification_method AS ENUM ('TON_PROOF', 'ADMIN_MANUAL');

-- ---------------------------------------------------------------------------
-- Networks and assets
-- ---------------------------------------------------------------------------

CREATE TYPE network_environment AS ENUM ('TESTNET', 'MAINNET');

-- ---------------------------------------------------------------------------
-- Ad providers, units, sessions, evidence
-- ---------------------------------------------------------------------------

CREATE TYPE ad_provider_status AS ENUM ('ACTIVE', 'PAUSED', 'SUSPENDED', 'DISABLED');

-- Spec §156F provider onboarding lifecycle.
CREATE TYPE provider_lifecycle_state AS ENUM (
    'CONTRACTED',
    'TECH_REVIEW',
    'SANDBOX',
    'SECURITY_VERIFIED',
    'ECONOMICS_VERIFIED',
    'LIMITED_TEST',
    'APPROVED',
    'PRODUCTION',
    'BLOCKED',
    'SUSPENDED',
    'REJECTED'
);

-- Spec §156D.3. Only APPROVED may receive production monetary traffic.
CREATE TYPE provider_monetary_status AS ENUM ('BLOCKED', 'TEST_ONLY', 'APPROVED', 'SUSPENDED');

CREATE TYPE provider_signal_authentication AS ENUM (
    'NONE',
    'SHARED_SECRET',
    'HMAC_SIGNATURE',
    'MUTUAL_TLS',
    'IP_ALLOWLIST',
    'OAUTH'
);

CREATE TYPE ad_format AS ENUM (
    'REWARDED_VIDEO',
    'REWARDED_INTERSTITIAL',
    'REWARDED_TASK',
    'OTHER'
);

-- Spec §18 derived ad session states.
CREATE TYPE ad_session_state AS ENUM (
    'CREATED',
    'QUOTED',
    'AUTHORIZED',
    'REQUESTED',
    'LOADED',
    'STARTED',
    'CLIENT_COMPLETION_RECEIVED',
    'PROVIDER_CONFIRMATION_RECEIVED',
    'PENDING_VERIFICATION',
    'VERIFIED',
    'REWARDED',
    'NO_FILL',
    'FAILED',
    'SKIPPED',
    'REJECTED',
    'EXPIRED'
);

CREATE TYPE ad_signal_source AS ENUM ('CLIENT', 'PROVIDER', 'SYSTEM');

CREATE TYPE ad_signal_authenticity_status AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

CREATE TYPE ad_signal_correlation_status AS ENUM (
    'UNCORRELATED',
    'CORRELATED',
    'AMBIGUOUS',
    'REJECTED'
);

CREATE TYPE ad_provider_event_status AS ENUM (
    'RECEIVED',
    'PROCESSED',
    'DUPLICATE',
    'IGNORED',
    'FAILED'
);

-- ---------------------------------------------------------------------------
-- Rewards and budgets
-- ---------------------------------------------------------------------------

CREATE TYPE reward_source_type AS ENUM (
    'AD',
    'TASK',
    'MISSION',
    'REFERRAL',
    'MEMBERSHIP_BONUS',
    'SUPPORT_ADJUSTMENT',
    'PROMOTION'
);

CREATE TYPE reward_quote_status AS ENUM ('OPEN', 'CONSUMED', 'CANCELLED', 'EXPIRED');

-- Spec §22 reward lifecycle.
CREATE TYPE reward_event_state AS ENUM ('CREATED', 'PENDING', 'AVAILABLE', 'REVERSED');

CREATE TYPE reward_maturity_status AS ENUM ('SCHEDULED', 'MATURED', 'CANCELLED', 'FAILED');

CREATE TYPE budget_scope_type AS ENUM (
    'GLOBAL',
    'PROVIDER',
    'COUNTRY_GROUP',
    'REWARD_RULE',
    'MEMBERSHIP_PLAN',
    'MISSION',
    'REFERRAL'
);

CREATE TYPE budget_period_granularity AS ENUM ('HOUR', 'UTC_DAY', 'UTC_MONTH');

-- Spec §21.5 / §93.6.
CREATE TYPE budget_reservation_state AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

CREATE TYPE ledger_owner_type AS ENUM ('USER', 'PLATFORM', 'WALLET', 'PROVIDER');

CREATE TYPE ledger_account_class AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

CREATE TYPE ledger_side AS ENUM ('DEBIT', 'CREDIT');

-- Spec §24 example account catalogue.
CREATE TYPE ledger_account_type AS ENUM (
    'USER_PENDING_LIABILITY',
    'USER_AVAILABLE_LIABILITY',
    'USER_RESERVED_LIABILITY',
    'PLATFORM_REWARD_EXPENSE',
    'MEMBERSHIP_BONUS_EXPENSE',
    'REFERRAL_REWARD_EXPENSE',
    'TASK_REWARD_EXPENSE',
    'MISSION_REWARD_EXPENSE',
    'WITHDRAWAL_FEE_REVENUE',
    'AD_REVENUE',
    'AD_NETWORK_RECEIVABLE',
    'HOT_WALLET_USDT_ASSET',
    'HOT_WALLET_TON_ASSET',
    'TREASURY_FUNDING_CLEARING',
    'TON_NETWORK_FEE_EXPENSE',
    'SUPPORT_COMPENSATION_EXPENSE',
    'INVALID_TRAFFIC_RECOVERY',
    'EXPLICIT_PLATFORM_LOSS'
);

CREATE TYPE ledger_transaction_type AS ENUM (
    'REWARD_ISSUANCE',
    'REWARD_MATURITY',
    'REWARD_REVERSAL',
    'MEMBERSHIP_BONUS_ISSUANCE',
    'REFERRAL_REWARD_ISSUANCE',
    'TASK_REWARD_ISSUANCE',
    'MISSION_REWARD_ISSUANCE',
    'WITHDRAWAL_RESERVATION',
    'WITHDRAWAL_RELEASE',
    'WITHDRAWAL_SETTLEMENT',
    'TON_NETWORK_FEE',
    'HOT_WALLET_FUNDING',
    'PROVIDER_REVENUE_ACCRUAL',
    'PROVIDER_SETTLEMENT',
    'INVALID_TRAFFIC_ADJUSTMENT',
    'SUPPORT_ADJUSTMENT',
    'PLATFORM_LOSS',
    'MANUAL_CORRECTION'
);

-- ---------------------------------------------------------------------------
-- Withdrawals, payouts, hot wallet
-- ---------------------------------------------------------------------------

CREATE TYPE withdrawal_quote_status AS ENUM ('OPEN', 'CONSUMED', 'CANCELLED', 'EXPIRED');

-- Spec §39. CONFIRMED and REJECTED are the only terminal states.
CREATE TYPE withdrawal_state AS ENUM (
    'REQUESTED',
    'RISK_CHECK',
    'MANUAL_REVIEW',
    'APPROVED',
    'QUEUED',
    'SIGNING',
    'BROADCASTING',
    'BROADCASTED',
    'CONFIRMING',
    'CONFIRMED',
    'HELD',
    'FAILED_PRE_BROADCAST',
    'RECONCILE_REQUIRED',
    'REJECTED'
);

CREATE TYPE withdrawal_decision AS ENUM ('APPROVE', 'HOLD', 'REJECT');

-- Spec §40.1 versioned risk policy outputs.
CREATE TYPE withdrawal_risk_decision AS ENUM (
    'MANUAL_REVIEW',
    'HELD',
    'REJECTED_PRE_BROADCAST',
    'WITHDRAWAL_BLOCKED'
);

-- Spec §95.4. An attempt that may have broadcast can never be FAILED_PRE_BROADCAST.
CREATE TYPE withdrawal_attempt_result AS ENUM (
    'PENDING',
    'BROADCASTED',
    'FAILED_PRE_BROADCAST',
    'UNKNOWN',
    'RECONCILE_REQUIRED'
);

CREATE TYPE blockchain_transaction_state AS ENUM (
    'OBSERVED',
    'PENDING',
    'CONFIRMED',
    'FAILED',
    'BOUNCED',
    'UNKNOWN'
);

CREATE TYPE hot_wallet_status AS ENUM ('ACTIVE', 'DRAINING', 'RETIRED', 'COMPROMISED');

-- Spec §34. No seed/private key material is ever stored in PostgreSQL.
CREATE TYPE hot_wallet_signer_type AS ENUM ('KMS', 'FALLBACK_ENCRYPTED');

-- ---------------------------------------------------------------------------
-- Risk and fraud
-- ---------------------------------------------------------------------------

CREATE TYPE fraud_flag_status AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED', 'CONFIRMED');

CREATE TYPE wallet_relationship_type AS ENUM (
    'SHARED_PAYOUT_WALLET',
    'SHARED_DEVICE_SIGNAL',
    'SHARED_NETWORK_SIGNAL',
    'MANUAL_LINK'
);

-- ---------------------------------------------------------------------------
-- Referral, tasks, missions
-- ---------------------------------------------------------------------------

CREATE TYPE referral_edge_state AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

CREATE TYPE task_progress_state AS ENUM (
    'NOT_STARTED',
    'IN_PROGRESS',
    'COMPLETED',
    'CLAIMED',
    'EXPIRED'
);

-- Spec §156P allowlisted mission conditions. No generic executable rules.
CREATE TYPE mission_condition_type AS ENUM (
    'DAILY_LOGIN',
    'VALID_AD_COUNT',
    'REFERRAL_ACTIVATION_COUNT',
    'STREAK_MILESTONE',
    'MEMBERSHIP_REQUIRED',
    'TIME_WINDOW',
    'COUNTRY_GROUP'
);

CREATE TYPE mission_reset_policy AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY');

CREATE TYPE mission_claim_status AS ENUM ('PENDING', 'GRANTED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- Admin, audit, system
-- ---------------------------------------------------------------------------

CREATE TYPE admin_status AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');

-- Spec §67. Only OWNER is enabled in V1.
CREATE TYPE admin_role_code AS ENUM (
    'OWNER',
    'FINANCE',
    'SUPPORT',
    'FRAUD_ANALYST',
    'CAMPAIGN_MANAGER'
);

-- Spec §66. TOTP alone is never a complete authentication method.
CREATE TYPE admin_credential_type AS ENUM ('PASSWORD', 'WEBAUTHN', 'TOTP');

CREATE TYPE telegram_destination_purpose AS ENUM (
    'PUBLIC_PAYOUT_LOGS',
    'PUBLIC_OFFICIAL_CHANNEL',
    'CONTROL_CENTER_APPROVALS',
    'CONTROL_CENTER_PAYOUTS',
    'CONTROL_CENTER_WARNINGS',
    'CONTROL_CENTER_CRITICAL',
    'CONTROL_CENTER_FRAUD',
    'CONTROL_CENTER_WALLET',
    'CONTROL_CENTER_ADS',
    'CONTROL_CENTER_SUPPORT',
    'CONTROL_CENTER_DAILY_REPORT'
);

CREATE TYPE publication_status AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'SKIPPED');

CREATE TYPE outbox_event_status AS ENUM ('PENDING', 'DISPATCHED', 'FAILED', 'DEAD_LETTER');

CREATE TYPE inbox_source AS ENUM ('PROVIDER', 'TELEGRAM', 'CHAIN', 'ADMIN', 'INTERNAL');

CREATE TYPE inbox_event_status AS ENUM (
    'RECEIVED',
    'PROCESSED',
    'DUPLICATE',
    'IGNORED',
    'FAILED'
);

CREATE TYPE idempotency_status AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- ---------------------------------------------------------------------------
-- Membership and entitlements (spec §156A/§156B)
-- ---------------------------------------------------------------------------

CREATE TYPE membership_billing_model AS ENUM ('FREE', 'ONE_TIME', 'SUBSCRIPTION_FUTURE');

CREATE TYPE membership_status AS ENUM ('ACTIVE', 'RESTRICTED', 'EXPIRED', 'REVOKED');

CREATE TYPE membership_source AS ENUM ('OWNER_GRANT', 'CLAIM_CODE', 'FUTURE_PURCHASE');

CREATE TYPE membership_grant_event_type AS ENUM (
    'GRANTED',
    'CLAIMED',
    'REASSIGNED',
    'RESTRICTED',
    'REVOKED',
    'REINSTATED'
);

CREATE TYPE entitlement_value_type AS ENUM (
    'BOOLEAN',
    'BPS',
    'INTEGER',
    'ATOMIC_AMOUNT',
    'ENUM'
);

CREATE TYPE entitlement_security_classification AS ENUM (
    'PUBLIC',
    'INTERNAL',
    'FINANCIAL',
    'SECURITY'
);

-- ---------------------------------------------------------------------------
-- Provider contracts, limits, certification, settlement (spec §2.1, §156E–§156N)
-- ---------------------------------------------------------------------------

CREATE TYPE provider_contract_status AS ENUM (
    'DRAFT',
    'ACTIVE',
    'SUSPENDED',
    'EXPIRED',
    'TERMINATED'
);

-- Spec §2.1 limit hierarchy. Provider/contract hard limits are absolute;
-- platform/user-tier limits may only ever be stricter.
CREATE TYPE provider_limit_scope AS ENUM (
    'PROVIDER_HARD',
    'CONTRACT',
    'PLATFORM_SOFT',
    'USER_TIER',
    'COUNTRY_OVERRIDE'
);

CREATE TYPE provider_limit_metric AS ENUM ('REQUEST', 'SUCCESS');

CREATE TYPE provider_limit_window AS ENUM ('HOUR', 'ROLLING_24H', 'UTC_DAY');

-- A hard limit may only be raised from a recorded trusted source.
CREATE TYPE provider_limit_source_type AS ENUM (
    'CONTRACT',
    'OFFICIAL_DOCUMENTATION',
    'WRITTEN_SUPPORT',
    'PROVIDER_ACCOUNT_CONFIG'
);

CREATE TYPE country_eligibility_status AS ENUM ('ELIGIBLE', 'RESTRICTED', 'INELIGIBLE');

-- Spec §156G mandatory certification cases.
CREATE TYPE provider_certification_case AS ENUM (
    'AVAILABILITY_SUCCESS',
    'NO_FILL',
    'LOAD_FAILURE',
    'START_FAILURE',
    'VALID_COMPLETION',
    'DUPLICATE_CLIENT_CALLBACK',
    'DUPLICATE_SERVER_CALLBACK',
    'SERVER_CALLBACK_BEFORE_CLIENT_CALLBACK',
    'LATE_CALLBACK',
    'INVALID_OR_MISSING_SIGNATURE',
    'REPLAY',
    'WRONG_USER',
    'WRONG_SESSION',
    'AMBIGUOUS_CORRELATION',
    'PROVIDER_TIMEOUT',
    'PROVIDER_OUTAGE',
    'REQUEST_CAP_REACHED',
    'SUCCESSFUL_CAP_REACHED',
    'COUNTRY_NOT_ELIGIBLE',
    'PROVIDER_SUSPENDED',
    'REPORTING_IMPORT',
    'SETTLEMENT_MISMATCH',
    'INVALID_TRAFFIC_REVERSAL_INPUT'
);

CREATE TYPE provider_certification_status AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'BLOCKED');

CREATE TYPE provider_settlement_status AS ENUM (
    'OPEN',
    'REPORTED',
    'RECONCILED',
    'SETTLED',
    'DISPUTED',
    'CLOSED'
);

CREATE TYPE provider_reporting_import_status AS ENUM (
    'PENDING',
    'IMPORTED',
    'PARTIAL',
    'FAILED'
);

-- ---------------------------------------------------------------------------
-- Trust, eligibility, review (spec §156J–§156O)
-- ---------------------------------------------------------------------------

-- Trust is separate from risk and from membership. Founder status never
-- implies trusted.
CREATE TYPE trust_state AS ENUM ('NEW', 'BASIC', 'ESTABLISHED', 'TRUSTED');

CREATE TYPE eligibility_action_type AS ENUM (
    'AD_SESSION_START',
    'WITHDRAWAL_REQUEST',
    'MISSION_CLAIM',
    'TASK_CLAIM',
    'REFERRAL_ACTIVATION',
    'MEMBERSHIP_CLAIM'
);

CREATE TYPE eligibility_outcome AS ENUM (
    'ELIGIBLE',
    'INELIGIBLE_PROVIDER_LIMIT',
    'INELIGIBLE_COUNTRY',
    'INELIGIBLE_ACCOUNT_STATE',
    'INELIGIBLE_RISK_POLICY',
    'INELIGIBLE_MEMBERSHIP',
    'INELIGIBLE_FEATURE_DISABLED'
);

CREATE TYPE review_case_type AS ENUM (
    'WITHDRAWAL_REVIEW',
    'FRAUD_REVIEW',
    'PROVIDER_ANOMALY',
    'INVALID_TRAFFIC',
    'REFERRAL_ABUSE',
    'FOUNDER_CLAIM_ISSUE',
    'MEMBERSHIP_REASSIGNMENT',
    'SUPPORT_ESCALATION',
    'RECONCILIATION_ISSUE'
);

CREATE TYPE review_case_state AS ENUM (
    'OPEN',
    'IN_REVIEW',
    'WAITING_INPUT',
    'ESCALATED',
    'RESOLVED',
    'DISMISSED'
);

CREATE TYPE review_case_event_type AS ENUM (
    'CREATED',
    'ASSIGNED',
    'COMMENTED',
    'STATE_CHANGED',
    'ACTION_INVOKED',
    'RESOLVED',
    'REOPENED'
);

-- ---------------------------------------------------------------------------
-- Support and notifications (spec §89, §90, §156Q)
-- ---------------------------------------------------------------------------

CREATE TYPE support_ticket_state AS ENUM (
    'OPEN',
    'WAITING_USER',
    'WAITING_SUPPORT',
    'RESOLVED',
    'CLOSED'
);

CREATE TYPE support_author_type AS ENUM ('USER', 'ADMIN', 'SYSTEM');

CREATE TYPE notification_channel AS ENUM (
    'IN_APP',
    'TELEGRAM_DM',
    'ADMIN_CONTROL_CENTER',
    'EMAIL'
);

-- SECURITY notifications may not be disabled where policy requires them.
CREATE TYPE notification_category AS ENUM ('SECURITY', 'TRANSACTIONAL', 'MARKETING', 'SYSTEM');

CREATE TYPE notification_delivery_status AS ENUM (
    'PENDING',
    'SENT',
    'DELIVERED',
    'FAILED',
    'SUPPRESSED'
);

CREATE TYPE notification_campaign_status AS ENUM (
    'DRAFT',
    'SCHEDULED',
    'RUNNING',
    'PAUSED',
    'COMPLETED',
    'CANCELLED'
);

CREATE TYPE notification_segment_code AS ENUM (
    'ALL_ELIGIBLE',
    'FOUNDERS',
    'COUNTRY_GROUP',
    'INACTIVE_N_DAYS',
    'WALLET_NOT_VERIFIED',
    'AVAILABLE_BALANCE_THRESHOLD',
    'MISSION_ELIGIBLE'
);

-- ---------------------------------------------------------------------------
-- Reconciliation and economic guardrails (spec §102, §156L)
-- ---------------------------------------------------------------------------

CREATE TYPE reconciliation_scope AS ENUM (
    'WITHDRAWAL',
    'HOT_WALLET',
    'PROVIDER',
    'LEDGER_BALANCE',
    'REWARD_BUDGET'
);

CREATE TYPE reconciliation_run_status AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

CREATE TYPE reconciliation_item_status AS ENUM (
    'MATCHED',
    'MISMATCHED',
    'MISSING_LOCAL',
    'MISSING_REMOTE',
    'PENDING'
);

CREATE TYPE reconciliation_issue_severity AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TYPE reconciliation_issue_status AS ENUM (
    'OPEN',
    'INVESTIGATING',
    'RESOLVED',
    'DISMISSED'
);

CREATE TYPE exposure_limit_code AS ENUM (
    'MAX_GLOBAL_HOURLY_REWARD_EXPENSE',
    'MAX_GLOBAL_DAILY_REWARD_EXPENSE',
    'MAX_PROVIDER_DAILY_REWARD_EXPENSE',
    'MAX_COUNTRY_DAILY_REWARD_EXPENSE',
    'MAX_MEMBERSHIP_BONUS_DAILY',
    'MAX_MEMBERSHIP_BONUS_MONTHLY',
    'MAX_REFERRAL_BONUS_DAILY',
    'MAX_MISSION_BONUS_DAILY',
    'MIN_EXPECTED_MARGIN_BPS',
    'MAX_UNSETTLED_PROVIDER_RECEIVABLE_EXPOSURE'
);

INSERT INTO schema_migrations (version)
VALUES ('0001_extensions_enums')
ON CONFLICT (version) DO NOTHING;

COMMIT;
