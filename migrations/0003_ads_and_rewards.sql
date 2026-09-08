-- ALEx Rewards — Phase 2 Database Baseline
-- 0003_ads_and_rewards.sql
--
-- Scope: ad providers, capability manifests, ad units, ad sessions and their
-- append-only evidence, authoritative daily counters, reward rules, quotes,
-- budgets, reservations, reward events and maturity scheduling.
--
-- Authority notes:
--   * Evidence tables never credit money. Money is posted only by the ledger.
--   * `ad_daily_counters` is the authoritative daily counter source (spec §15).
--   * Admin foreign keys are attached in migration 0007 (admin tables come later).

BEGIN;

-- ---------------------------------------------------------------------------
-- Providers and capability manifests (spec §92.1, §156D.3)
-- ---------------------------------------------------------------------------

CREATE TABLE ad_providers (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code                      TEXT NOT NULL,
    name                      TEXT NOT NULL,
    status                    ad_provider_status NOT NULL DEFAULT 'DISABLED',
    lifecycle_state           provider_lifecycle_state NOT NULL DEFAULT 'CONTRACTED',
    production_monetary_status provider_monetary_status NOT NULL DEFAULT 'BLOCKED',
    capabilities              JSONB NOT NULL DEFAULT '{}'::jsonb,
    policy_reference          TEXT NULL,
    policy_reviewed_at        TIMESTAMPTZ NULL,
    rewarded_use_allowed      BOOLEAN NOT NULL DEFAULT false,
    incentivized_crypto_allowed BOOLEAN NOT NULL DEFAULT false,
    server_verification_supported BOOLEAN NOT NULL DEFAULT false,
    restricted_categories_reference TEXT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_providers_code_key UNIQUE (code)
);

COMMENT ON TABLE ad_providers IS
    'Provider policy registry (spec §120). Only production_monetary_status = APPROVED '
    'may receive production monetary traffic; adapter code alone never enables a provider.';

CREATE TRIGGER ad_providers_set_updated_at
    BEFORE UPDATE ON ad_providers
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE ad_provider_manifests (
    id                                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id                       UUID NOT NULL REFERENCES ad_providers (id) ON DELETE CASCADE,
    manifest_version                  INTEGER NOT NULL CHECK (manifest_version > 0),
    environment                       environment_name NOT NULL,
    adapter_version                   TEXT NOT NULL,
    supported_formats                 ad_format[] NOT NULL DEFAULT '{}',
    rewarded_supported                BOOLEAN NOT NULL DEFAULT false,
    server_reward_signal_supported    BOOLEAN NOT NULL DEFAULT false,
    server_signal_authentication      provider_signal_authentication NOT NULL DEFAULT 'NONE',
    unique_event_id_supported         BOOLEAN NOT NULL DEFAULT false,
    session_correlation_supported     BOOLEAN NOT NULL DEFAULT false,
    custom_nonce_supported            BOOLEAN NOT NULL DEFAULT false,
    retry_delivery_documented         BOOLEAN NOT NULL DEFAULT false,
    provider_side_limit_supported     BOOLEAN NOT NULL DEFAULT false,
    reporting_api_supported           BOOLEAN NOT NULL DEFAULT false,
    revenue_reporting_supported       BOOLEAN NOT NULL DEFAULT false,
    country_reporting_supported       BOOLEAN NOT NULL DEFAULT false,
    credentials_reference             TEXT NULL,
    policy_status                     TEXT NULL,
    production_monetary_status        provider_monetary_status NOT NULL DEFAULT 'BLOCKED',
    status                            rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to                      TIMESTAMPTZ NULL,
    created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_provider_manifests_version_key
        UNIQUE (provider_id, environment, manifest_version),
    CONSTRAINT ad_provider_manifests_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE ad_provider_manifests IS
    'Immutable versioned provider capability manifests consumed by later adapter phases. '
    'credentials_reference points at a secret manager entry; secrets never live here.';

CREATE INDEX ad_provider_manifests_active_idx
    ON ad_provider_manifests (provider_id, environment)
    WHERE status = 'ACTIVE';

CREATE TRIGGER ad_provider_manifests_set_updated_at
    BEFORE UPDATE ON ad_provider_manifests
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Ad units (spec §92.2)
-- ---------------------------------------------------------------------------

CREATE TABLE ad_units (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id       UUID NOT NULL REFERENCES ad_providers (id) ON DELETE CASCADE,
    provider_block_id TEXT NOT NULL,
    placement_code    TEXT NOT NULL,
    format            ad_format NOT NULL DEFAULT 'REWARDED_VIDEO',
    environment       environment_name NOT NULL,
    status            content_status NOT NULL DEFAULT 'DRAFT',
    client_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    server_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_units_provider_block_key UNIQUE (provider_id, environment, provider_block_id),
    CONSTRAINT ad_units_placement_key UNIQUE (provider_id, environment, placement_code)
);

COMMENT ON TABLE ad_units IS
    'Provider placements. client_config holds only values the provider SDK must receive; '
    'secret provider configuration stays in server_config and is never sent to clients.';

CREATE TRIGGER ad_units_set_updated_at
    BEFORE UPDATE ON ad_units
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Reward rules and budgets (spec §21, §93.1, §93.5)
-- ---------------------------------------------------------------------------

CREATE TABLE reward_rules (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code                  TEXT NOT NULL,
    rule_version          INTEGER NOT NULL CHECK (rule_version > 0),
    source_type           reward_source_type NOT NULL,
    provider_id           UUID NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    country_group         TEXT NULL,
    asset_id              UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    -- Economic parameters are typed configuration, never executable rule code.
    user_share_bps        INTEGER NULL CHECK (user_share_bps BETWEEN 0 AND 10000),
    safety_factor_bps     INTEGER NULL CHECK (safety_factor_bps BETWEEN 0 AND 10000),
    estimated_ecpm_atomic BIGINT NULL CHECK (estimated_ecpm_atomic > 0),
    min_reward_atomic     BIGINT NULL CHECK (min_reward_atomic > 0),
    max_reward_atomic     BIGINT NULL CHECK (max_reward_atomic > 0),
    fixed_reward_atomic   BIGINT NULL CHECK (fixed_reward_atomic > 0),
    pending_hold_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (pending_hold_seconds >= 0),
    quote_ttl_seconds     INTEGER NOT NULL DEFAULT 0 CHECK (quote_ttl_seconds >= 0),
    parameters            JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                rule_version_status NOT NULL DEFAULT 'DRAFT',
    valid_from            TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to              TIMESTAMPTZ NULL,
    source_reference      TEXT NULL,
    reason                TEXT NULL,
    created_by_admin_id   UUID NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reward_rules_version_key UNIQUE (code, rule_version),
    CONSTRAINT reward_rules_valid_window CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT reward_rules_min_max_order
        CHECK (
            min_reward_atomic IS NULL
            OR max_reward_atomic IS NULL
            OR max_reward_atomic >= min_reward_atomic
        )
);

-- Launch economics are OWNER_DECISION_REQUIRED; this table stores versioned values
-- rather than hardcoding any production number as a schema constraint.
COMMENT ON TABLE reward_rules IS
    'Immutable versioned reward economics. Quotes pin rule_version so later changes '
    'never alter an already valid quote (spec §112).';

CREATE INDEX reward_rules_lookup_idx
    ON reward_rules (source_type, provider_id, status, valid_from DESC);

CREATE TRIGGER reward_rules_set_updated_at
    BEFORE UPDATE ON reward_rules
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE reward_budget_periods (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    scope_type          budget_scope_type NOT NULL,
    scope_reference_id  UUID NULL,
    country_group       TEXT NULL,
    asset_id            UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    granularity         budget_period_granularity NOT NULL,
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    budget_atomic       BIGINT NOT NULL CHECK (budget_atomic > 0),
    reserved_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
    consumed_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (consumed_atomic >= 0),
    released_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (released_atomic >= 0),
    rule_version        INTEGER NULL,
    status              activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reward_budget_periods_scope_key
        UNIQUE NULLS NOT DISTINCT (
            scope_type, scope_reference_id, country_group, asset_id, granularity, period_start
        ),
    CONSTRAINT reward_budget_periods_window CHECK (period_end > period_start),
    CONSTRAINT reward_budget_periods_projection_bounded
        CHECK (reserved_atomic + consumed_atomic <= budget_atomic)
);

COMMENT ON TABLE reward_budget_periods IS
    'Authoritative atomic reward budgets and reserved/consumed projections for an explicit '
    'UTC period. Reservation changes and projections commit atomically (spec §21.5).';

CREATE INDEX reward_budget_periods_window_idx
    ON reward_budget_periods (scope_type, period_start DESC, period_end);

CREATE TRIGGER reward_budget_periods_set_updated_at
    BEFORE UPDATE ON reward_budget_periods
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Reward quotes and reservations (spec §21.3, §93.2, §93.6)
-- ---------------------------------------------------------------------------

CREATE TABLE reward_quotes (
    id                            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                       UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    source_type                   reward_source_type NOT NULL,
    source_id                     UUID NOT NULL,
    provider_id                   UUID NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    ad_unit_id                    UUID NULL REFERENCES ad_units (id) ON DELETE RESTRICT,
    asset_id                      UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    reward_rule_id                UUID NOT NULL REFERENCES reward_rules (id) ON DELETE RESTRICT,
    rule_version                  INTEGER NOT NULL,
    base_amount_atomic            BIGINT NOT NULL CHECK (base_amount_atomic > 0),
    membership_bonus_amount_atomic BIGINT NOT NULL DEFAULT 0
                                  CHECK (membership_bonus_amount_atomic >= 0),
    amount_atomic                 BIGINT NOT NULL CHECK (amount_atomic > 0),
    membership_id                 UUID NULL,
    status                        reward_quote_status NOT NULL DEFAULT 'OPEN',
    expires_at                    TIMESTAMPTZ NOT NULL,
    consumed_at                   TIMESTAMPTZ NULL,
    cancelled_at                  TIMESTAMPTZ NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reward_quotes_source_key UNIQUE (source_type, source_id),
    CONSTRAINT reward_quotes_total_matches_parts
        CHECK (amount_atomic = base_amount_atomic + membership_bonus_amount_atomic),
    CONSTRAINT reward_quotes_expiry_after_creation CHECK (expires_at > created_at)
);

COMMENT ON TABLE reward_quotes IS
    'Server-issued reward quote pinned to a rule version. source_id references the '
    'originating ad session / task / mission row; it is intentionally not a foreign key '
    'because the source table varies by source_type.';
COMMENT ON COLUMN reward_quotes.membership_bonus_amount_atomic IS
    'Platform-funded membership bonus portion, kept separable from the base reward (spec §156A.6).';

CREATE INDEX reward_quotes_user_status_idx ON reward_quotes (user_id, status, created_at DESC);
CREATE INDEX reward_quotes_open_expiry_idx
    ON reward_quotes (expires_at)
    WHERE status = 'OPEN';

CREATE TRIGGER reward_quotes_set_updated_at
    BEFORE UPDATE ON reward_quotes
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE reward_budget_reservations (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    reward_quote_id   UUID NOT NULL REFERENCES reward_quotes (id) ON DELETE RESTRICT,
    budget_period_id  UUID NOT NULL REFERENCES reward_budget_periods (id) ON DELETE RESTRICT,
    amount_atomic     BIGINT NOT NULL CHECK (amount_atomic > 0),
    state             budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at       TIMESTAMPTZ NULL,
    consumed_at       TIMESTAMPTZ NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Spec §93.6: exactly one reservation per quote.
    CONSTRAINT reward_budget_reservations_quote_key UNIQUE (reward_quote_id),
    CONSTRAINT reward_budget_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE reward_budget_reservations IS
    'One budget reservation per reward quote; released on pre-start expiry, consumed on reward.';

CREATE INDEX reward_budget_reservations_period_idx
    ON reward_budget_reservations (budget_period_id, state);

CREATE TRIGGER reward_budget_reservations_set_updated_at
    BEFORE UPDATE ON reward_budget_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Ad sessions and evidence (spec §18, §92.3–§92.6)
-- ---------------------------------------------------------------------------

CREATE TABLE ad_sessions (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    provider_id               UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    ad_unit_id                UUID NULL REFERENCES ad_units (id) ON DELETE RESTRICT,
    reward_quote_id           UUID NULL REFERENCES reward_quotes (id) ON DELETE RESTRICT,
    state                     ad_session_state NOT NULL DEFAULT 'CREATED',
    utc_day                   DATE NOT NULL,
    provider_request_counted  BOOLEAN NOT NULL DEFAULT false,
    successful_reward_counted BOOLEAN NOT NULL DEFAULT false,
    correlation_nonce_hash    TEXT NULL,
    country_code              TEXT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    failure_code              TEXT NULL,
    started_at                TIMESTAMPTZ NULL,
    client_completed_at       TIMESTAMPTZ NULL,
    provider_confirmed_at     TIMESTAMPTZ NULL,
    verified_at               TIMESTAMPTZ NULL,
    rewarded_at               TIMESTAMPTZ NULL,
    expires_at                TIMESTAMPTZ NOT NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_sessions_reward_quote_key UNIQUE (reward_quote_id),
    CONSTRAINT ad_sessions_rewarded_requires_quote
        CHECK (state <> 'REWARDED' OR reward_quote_id IS NOT NULL)
);

COMMENT ON TABLE ad_sessions IS
    'One rewarded ad attempt. State is derived from append-only signals plus domain '
    'decisions; a terminal session can never create a second reward (spec §18).';

-- Spec §17: at most one live session per user per provider.
CREATE UNIQUE INDEX ad_sessions_one_active_per_user_provider_idx
    ON ad_sessions (user_id, provider_id)
    WHERE state IN (
        'CREATED', 'QUOTED', 'AUTHORIZED', 'REQUESTED', 'LOADED', 'STARTED',
        'CLIENT_COMPLETION_RECEIVED', 'PROVIDER_CONFIRMATION_RECEIVED',
        'PENDING_VERIFICATION', 'VERIFIED'
    );

CREATE INDEX ad_sessions_user_day_idx ON ad_sessions (user_id, utc_day, state);
CREATE INDEX ad_sessions_provider_created_idx ON ad_sessions (provider_id, created_at DESC);
CREATE INDEX ad_sessions_expiry_idx
    ON ad_sessions (expires_at)
    WHERE state NOT IN ('REWARDED', 'NO_FILL', 'FAILED', 'SKIPPED', 'REJECTED', 'EXPIRED');

CREATE TRIGGER ad_sessions_set_updated_at
    BEFORE UPDATE ON ad_sessions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE ad_client_events (
    id            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    ad_session_id UUID NOT NULL REFERENCES ad_sessions (id) ON DELETE CASCADE,
    event_type    TEXT NOT NULL,
    safe_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ad_client_events IS
    'Client-reported debugging/forensic events. These NEVER credit money (spec §92.4). '
    'Subject to a retention policy.';

CREATE INDEX ad_client_events_session_idx ON ad_client_events (ad_session_id, created_at);

CREATE TRIGGER ad_client_events_reject_update
    BEFORE UPDATE ON ad_client_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TABLE ad_session_signals (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    ad_session_id         UUID NOT NULL REFERENCES ad_sessions (id) ON DELETE CASCADE,
    source                ad_signal_source NOT NULL,
    signal_type           TEXT NOT NULL,
    provider_event_id     TEXT NULL,
    occurred_at           TIMESTAMPTZ NULL,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    authenticity_status   ad_signal_authenticity_status NOT NULL DEFAULT 'UNVERIFIED',
    correlation_status    ad_signal_correlation_status NOT NULL DEFAULT 'UNCORRELATED',
    safe_payload_hash     TEXT NOT NULL,
    safe_payload_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Foreign key attached in 0007 once inbox_events exists.
    inbox_event_id        UUID NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ad_session_signals_provider_event_key
        UNIQUE NULLS NOT DISTINCT (ad_session_id, source, signal_type, provider_event_id)
);

COMMENT ON TABLE ad_session_signals IS
    'Append-only, monotonic ad evidence from client/provider/system. Signals never post '
    'money; aggregate session state is derived from them (spec §92.4A).';

CREATE INDEX ad_session_signals_session_idx ON ad_session_signals (ad_session_id, received_at);

CREATE TRIGGER ad_session_signals_reject_delete
    BEFORE DELETE ON ad_session_signals
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TABLE ad_provider_events (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id             UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    provider_event_id       TEXT NULL,
    telegram_user_id        BIGINT NULL,
    normalized_event_type   TEXT NOT NULL,
    raw_payload_redacted    JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload_hash            TEXT NOT NULL,
    authenticity_status     ad_signal_authenticity_status NOT NULL DEFAULT 'UNVERIFIED',
    processing_status       ad_provider_event_status NOT NULL DEFAULT 'RECEIVED',
    correlated_ad_session_id UUID NULL REFERENCES ad_sessions (id) ON DELETE SET NULL,
    -- Foreign key attached in 0007 once inbox_events exists.
    inbox_event_id          UUID NULL,
    received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Spec §92.5: where the provider supplies a unique event id, enforce uniqueness.
    CONSTRAINT ad_provider_events_provider_event_key UNIQUE (provider_id, provider_event_id)
);

COMMENT ON TABLE ad_provider_events IS
    'Normalized provider server callbacks. Correlation and authenticity are recorded here; '
    'reward decisions still run through the reward engine and ledger.';

CREATE INDEX ad_provider_events_status_idx
    ON ad_provider_events (processing_status, received_at);
CREATE INDEX ad_provider_events_session_idx
    ON ad_provider_events (correlated_ad_session_id)
    WHERE correlated_ad_session_id IS NOT NULL;

CREATE TABLE ad_daily_counters (
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id       UUID NOT NULL REFERENCES ad_providers (id) ON DELETE CASCADE,
    utc_day           DATE NOT NULL,
    provider_requests INTEGER NOT NULL DEFAULT 0 CHECK (provider_requests >= 0),
    successful_rewards INTEGER NOT NULL DEFAULT 0 CHECK (successful_rewards >= 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider_id, utc_day)
);

COMMENT ON TABLE ad_daily_counters IS
    'Authoritative DB-backed daily counters (spec §15/§92.6). Redis is never authoritative. '
    'Effective caps come from versioned provider_limit_rules, not from schema constants.';

CREATE INDEX ad_daily_counters_day_idx ON ad_daily_counters (utc_day, provider_id);

CREATE TRIGGER ad_daily_counters_set_updated_at
    BEFORE UPDATE ON ad_daily_counters
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Reward events and maturity (spec §22, §93.3, §93.4)
-- ---------------------------------------------------------------------------

CREATE TABLE reward_events (
    id                             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    source_type                    reward_source_type NOT NULL,
    source_id                      UUID NOT NULL,
    reward_quote_id                UUID NULL REFERENCES reward_quotes (id) ON DELETE RESTRICT,
    asset_id                       UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    amount_atomic                  BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                          reward_event_state NOT NULL DEFAULT 'CREATED',
    reward_rule_id                 UUID NULL REFERENCES reward_rules (id) ON DELETE RESTRICT,
    rule_version                   INTEGER NULL,
    -- Foreign keys attached in 0004 once ledger_transactions exists.
    ledger_transaction_id          UUID NULL,
    maturity_ledger_transaction_id UUID NULL,
    reversal_ledger_transaction_id UUID NULL,
    pending_until                  TIMESTAMPTZ NULL,
    available_at                   TIMESTAMPTZ NULL,
    reversed_at                    TIMESTAMPTZ NULL,
    reversal_reason                TEXT NULL,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Spec §93.3: one reward per originating business source, ever.
    CONSTRAINT reward_events_source_key UNIQUE (source_type, source_id),
    CONSTRAINT reward_events_quote_key UNIQUE (reward_quote_id)
);

COMMENT ON TABLE reward_events IS
    'Business record of an issued reward. The financial truth is the linked ledger '
    'transaction; this row never stores a spendable balance.';

CREATE INDEX reward_events_user_state_idx ON reward_events (user_id, state, created_at DESC);
CREATE INDEX reward_events_pending_idx
    ON reward_events (pending_until)
    WHERE state = 'PENDING';

CREATE TRIGGER reward_events_set_updated_at
    BEFORE UPDATE ON reward_events
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE reward_maturities (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    reward_event_id    UUID NOT NULL REFERENCES reward_events (id) ON DELETE CASCADE,
    scheduled_for      TIMESTAMPTZ NOT NULL,
    status             reward_maturity_status NOT NULL DEFAULT 'SCHEDULED',
    workflow_id        TEXT NULL,
    attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    matured_at         TIMESTAMPTZ NULL,
    cancelled_at       TIMESTAMPTZ NULL,
    last_error_redacted TEXT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reward_maturities_reward_event_key UNIQUE (reward_event_id),
    CONSTRAINT reward_maturities_workflow_key UNIQUE (workflow_id)
);

COMMENT ON TABLE reward_maturities IS
    'Resumable, idempotent maturity scheduling keyed by reward-maturity/{reward_event_id}.';

CREATE INDEX reward_maturities_due_idx
    ON reward_maturities (scheduled_for)
    WHERE status = 'SCHEDULED';

CREATE TRIGGER reward_maturities_set_updated_at
    BEFORE UPDATE ON reward_maturities
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0003_ads_and_rewards')
ON CONFLICT (version) DO NOTHING;

COMMIT;
