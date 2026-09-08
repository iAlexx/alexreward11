-- ALEx Rewards — Phase 2 Database Baseline
-- 0002_networks_assets_users.sql
--
-- Scope: chain networks, deployment-controlled assets, user identity, profile,
-- settings, sessions and TON payout wallets.
--
-- Authority notes:
--   * `users` NEVER carries an authoritative balance column. User money lives in
--     the immutable ledger (migration 0004) only.
--   * `assets` is deployment-controlled. Clients never supply a token master.

BEGIN;

-- ---------------------------------------------------------------------------
-- Networks and assets (spec §91.0)
-- ---------------------------------------------------------------------------

CREATE TABLE networks (
    id                       UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code                     TEXT NOT NULL,
    chain                    TEXT NOT NULL DEFAULT 'TON',
    environment              network_environment NOT NULL,
    display_name             TEXT NOT NULL,
    global_chain_identifier  TEXT NULL,
    public_explorer_base_url TEXT NULL,
    status                   activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT networks_code_key UNIQUE (code)
);

COMMENT ON TABLE networks IS
    'Blockchain networks accepted by this deployment. Owned by platform configuration.';
COMMENT ON COLUMN networks.global_chain_identifier IS
    'Network identifier used when validating ton_proof network binding (spec §27.11).';

CREATE TRIGGER networks_set_updated_at
    BEFORE UPDATE ON networks
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE assets (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    network_id        UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    symbol            TEXT NOT NULL,
    name              TEXT NOT NULL,
    decimals          SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 18),
    is_native         BOOLEAN NOT NULL DEFAULT false,
    contract_identity TEXT NULL,
    status            activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT assets_identity_key
        UNIQUE NULLS NOT DISTINCT (network_id, symbol, contract_identity),
    CONSTRAINT assets_native_has_no_contract
        CHECK ((is_native AND contract_identity IS NULL) OR NOT is_native)
);

COMMENT ON TABLE assets IS
    'Allowlisted assets per network. Deployment-controlled; never selectable by a client.';
COMMENT ON COLUMN assets.contract_identity IS
    'Canonical contract identity (Jetton master address for TON jettons). NULL for native coin.';

CREATE INDEX assets_network_status_idx ON assets (network_id, status);

CREATE TRIGGER assets_set_updated_at
    BEFORE UPDATE ON assets
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Users (spec §91.1)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id                          UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    telegram_user_id            BIGINT NOT NULL,
    username                    TEXT NULL,
    first_name                  TEXT NULL,
    last_name                   TEXT NULL,
    telegram_language_code      TEXT NULL,
    preferred_locale            TEXT NOT NULL DEFAULT 'en'
                                CHECK (preferred_locale IN ('en', 'ar', 'ru')),
    country_code                TEXT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    country_source              TEXT NULL,
    status                      user_status NOT NULL DEFAULT 'ACTIVE',
    withdrawal_status           user_withdrawal_access_status NOT NULL DEFAULT 'ALLOWED',
    risk_tier                   risk_tier NOT NULL DEFAULT 'LOW',
    trust_state                 trust_state NOT NULL DEFAULT 'NEW',
    kyc_status                  kyc_status NOT NULL DEFAULT 'NOT_REQUIRED',
    primary_wallet_changed_at   TIMESTAMPTZ NULL,
    withdrawal_cooldown_until   TIMESTAMPTZ NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at              TIMESTAMPTZ NULL,
    anonymized_at               TIMESTAMPTZ NULL,
    CONSTRAINT users_telegram_user_id_key UNIQUE (telegram_user_id)
);

-- Spec §3.2 / AGENTS.md: no mutable authoritative balance shortcut exists here.
-- Pending/Available/Reserved buckets are derived from the immutable ledger.
COMMENT ON TABLE users IS
    'Telegram-authenticated user identity. Deliberately holds NO balance column; '
    'all money truth lives in ledger_entries / ledger_account_balances.';
COMMENT ON COLUMN users.telegram_user_id IS
    'Provider identity after initData signature validation. Usernames are never identity.';
COMMENT ON COLUMN users.withdrawal_cooldown_until IS
    'Set by wallet-change security (spec §29); withdrawals stay blocked until this time.';

CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_country_code_idx ON users (country_code) WHERE country_code IS NOT NULL;
CREATE INDEX users_last_active_at_idx ON users (last_active_at DESC NULLS LAST);
CREATE INDEX users_created_at_idx ON users (created_at DESC);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- User profile and settings (spec §91.2, §91.3)
-- ---------------------------------------------------------------------------

CREATE TABLE user_profiles (
    user_id             UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    display_name        TEXT NULL,
    avatar_reference    TEXT NULL,
    timezone_offset_min SMALLINT NULL CHECK (timezone_offset_min BETWEEN -840 AND 840),
    onboarding_stage    TEXT NULL,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_profiles IS
    'Non-financial profile metadata only. Never an input to money decisions.';

CREATE TRIGGER user_profiles_set_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE user_settings (
    user_id                          UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    locale                           TEXT NOT NULL DEFAULT 'en'
                                     CHECK (locale IN ('en', 'ar', 'ru')),
    public_payout_identity_mode      public_payout_identity_mode NOT NULL DEFAULT 'HIDE_IDENTITY',
    marketing_notifications_enabled  BOOLEAN NOT NULL DEFAULT true,
    security_notifications_enabled   BOOLEAN NOT NULL DEFAULT true,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Spec §91.3: mandatory security notifications cannot be switched off.
    CONSTRAINT user_settings_security_notifications_required
        CHECK (security_notifications_enabled)
);

COMMENT ON TABLE user_settings IS
    'User-controlled preferences. Marketing consent gates campaign delivery (spec §156Q).';

CREATE TRIGGER user_settings_set_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Sessions (spec §7.3, §91.4)
-- ---------------------------------------------------------------------------

CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_secret_hash TEXT NOT NULL,
    refresh_token_hash  TEXT NULL,
    ip_hash             TEXT NULL,
    user_agent_summary  TEXT NULL,
    device_summary      TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ NULL,
    revoked_reason      session_revocation_reason NULL,
    CONSTRAINT user_sessions_session_secret_hash_key UNIQUE (session_secret_hash),
    CONSTRAINT user_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash),
    CONSTRAINT user_sessions_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT user_sessions_revocation_consistent
        CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

COMMENT ON TABLE user_sessions IS
    'Hashed session/refresh secrets only. Raw long-lived bearer tokens are never stored.';

CREATE INDEX user_sessions_user_active_idx
    ON user_sessions (user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- User payout wallets (spec §26–§29, §91, §28)
-- ---------------------------------------------------------------------------

CREATE TABLE user_wallets (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id              UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    network_id           UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    chain                TEXT NOT NULL DEFAULT 'TON',
    raw_address          TEXT NOT NULL,
    friendly_address     TEXT NOT NULL,
    wallet_name          TEXT NULL,
    is_primary           BOOLEAN NOT NULL DEFAULT false,
    verified             BOOLEAN NOT NULL DEFAULT false,
    verification_method  wallet_verification_method NULL,
    verified_at          TIMESTAMPTZ NULL,
    became_primary_at    TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at         TIMESTAMPTZ NULL,
    disabled_at          TIMESTAMPTZ NULL,
    CONSTRAINT user_wallets_address_key UNIQUE (user_id, network_id, raw_address),
    CONSTRAINT user_wallets_verification_consistent
        CHECK (
            (NOT verified AND verified_at IS NULL AND verification_method IS NULL)
            OR (verified AND verified_at IS NOT NULL AND verification_method IS NOT NULL)
        )
);

COMMENT ON TABLE user_wallets IS
    'User-owned TON payout wallets. Private keys/seeds are never stored. '
    'Ownership is proven through ton_proof (spec §27).';

-- Exactly one active primary wallet per user per network.
CREATE UNIQUE INDEX user_wallets_one_primary_per_network_idx
    ON user_wallets (user_id, network_id)
    WHERE is_primary AND disabled_at IS NULL;

CREATE INDEX user_wallets_raw_address_idx ON user_wallets (network_id, raw_address);

CREATE TRIGGER user_wallets_set_updated_at
    BEFORE UPDATE ON user_wallets
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE user_wallet_proof_nonces (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    network_id         UUID NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
    nonce_hash         TEXT NOT NULL,
    issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ NOT NULL,
    consumed_at        TIMESTAMPTZ NULL,
    consumed_wallet_id UUID NULL REFERENCES user_wallets (id) ON DELETE SET NULL,
    CONSTRAINT user_wallet_proof_nonces_nonce_hash_key UNIQUE (nonce_hash),
    CONSTRAINT user_wallet_proof_nonces_ttl CHECK (expires_at > issued_at)
);

COMMENT ON TABLE user_wallet_proof_nonces IS
    'Single-use ton_proof challenges. Consumption is atomic; replay must fail (spec §27).';

CREATE INDEX user_wallet_proof_nonces_open_idx
    ON user_wallet_proof_nonces (user_id, expires_at)
    WHERE consumed_at IS NULL;

INSERT INTO schema_migrations (version)
VALUES ('0002_networks_assets_users')
ON CONFLICT (version) DO NOTHING;

COMMIT;
