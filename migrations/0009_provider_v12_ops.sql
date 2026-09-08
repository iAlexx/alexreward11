-- ALEx Rewards — Phase 2 Database Baseline
-- 0009_provider_v12_ops.sql
--
-- Scope: V1.2 provider operations — contract registry, versioned provider limit
-- rules (spec §2.1), country/region rules, routing policy versions, certification
-- runs/results, settlement periods/items, reporting imports — plus the trust and
-- eligibility projections.
--
-- Authority notes:
--   * Provider/contract hard limits are absolute. Platform, user-tier and country
--     rules may only ever be stricter, never looser. The effective limit is the
--     safest applicable allowed limit; it is computed by the domain engine.
--   * A hard limit may only be raised from a recorded trusted source. No rumour,
--     client value or user tier can raise it.
--   * Trust is separate from risk and from membership. Founder status never
--     implies trusted, and trust never overrides a critical fraud block.

BEGIN;

-- ---------------------------------------------------------------------------
-- Provider contract registry (spec §156E)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_contracts (
    id                             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id                    UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    contract_reference             TEXT NOT NULL,
    contract_status                provider_contract_status NOT NULL DEFAULT 'DRAFT',
    contract_start                 DATE NULL,
    contract_end                   DATE NULL,
    payment_terms                  TEXT NULL,
    settlement_currency            TEXT NULL,
    revenue_share_terms_reference  TEXT NULL,
    allowed_traffic_model          TEXT NULL,
    rewarded_cash_crypto_allowed   BOOLEAN NOT NULL DEFAULT false,
    allowed_countries_reference    TEXT NULL,
    restricted_categories_reference TEXT NULL,
    provider_request_limit_reference TEXT NULL,
    reporting_method               TEXT NULL,
    settlement_cycle               TEXT NULL,
    minimum_provider_payout_atomic BIGINT NULL CHECK (minimum_provider_payout_atomic > 0),
    contact_reference              TEXT NULL,
    contract_document_secure_reference TEXT NULL,
    review_due_at                  TIMESTAMPTZ NULL,
    reviewed_at                    TIMESTAMPTZ NULL,
    reviewed_by_admin_id           UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    notes                          TEXT NULL,
    created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_contracts_reference_key UNIQUE (provider_id, contract_reference),
    CONSTRAINT provider_contracts_period CHECK (contract_end IS NULL OR contract_start IS NULL
        OR contract_end >= contract_start)
);

COMMENT ON TABLE provider_contracts IS
    'Structured commercial contract metadata. Document references point at secure storage; '
    'contract documents and provider secrets never live in this database (spec §156E).';

CREATE INDEX provider_contracts_review_due_idx
    ON provider_contracts (review_due_at)
    WHERE review_due_at IS NOT NULL;

CREATE TRIGGER provider_contracts_set_updated_at
    BEFORE UPDATE ON provider_contracts
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Versioned provider limit rules (spec §2.1)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_limit_rules (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id          UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    provider_contract_id UUID NULL REFERENCES provider_contracts (id) ON DELETE RESTRICT,
    limit_scope          provider_limit_scope NOT NULL,
    limit_metric         provider_limit_metric NOT NULL,
    limit_window         provider_limit_window NOT NULL,
    country_code         TEXT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    risk_tier            risk_tier NULL,
    max_count            INTEGER NOT NULL CHECK (max_count >= 0),
    cooldown_seconds     INTEGER NULL CHECK (cooldown_seconds >= 0),
    rule_version         INTEGER NOT NULL CHECK (rule_version > 0),
    status               rule_version_status NOT NULL DEFAULT 'DRAFT',
    valid_from           TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to             TIMESTAMPTZ NULL,
    source_type          provider_limit_source_type NOT NULL,
    source_reference     TEXT NOT NULL,
    impact_preview       JSONB NULL,
    reason               TEXT NULL,
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at          TIMESTAMPTZ NULL,
    audit_log_id         UUID NULL REFERENCES audit_logs (id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Duplicate versions of the same limit dimension are rejected outright.
    CONSTRAINT provider_limit_rules_version_key
        UNIQUE NULLS NOT DISTINCT (
            provider_id, limit_scope, limit_metric, limit_window,
            country_code, risk_tier, rule_version
        ),
    CONSTRAINT provider_limit_rules_valid_window
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    -- Hard limits are contractual facts and must be approved with a trusted source.
    CONSTRAINT provider_limit_rules_hard_limit_requires_approval
        CHECK (
            status <> 'ACTIVE'
            OR limit_scope NOT IN ('PROVIDER_HARD', 'CONTRACT')
            OR approved_by_admin_id IS NOT NULL
        ),
    -- Exactly one active rule per dimension at any instant (untiered dimension).
    CONSTRAINT provider_limit_rules_no_active_overlap
        EXCLUDE USING gist (
            provider_id WITH =,
            limit_scope WITH =,
            limit_metric WITH =,
            limit_window WITH =,
            (COALESCE(country_code, '*')) WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE' AND risk_tier IS NULL),
    -- Same rule for explicitly tiered limits.
    CONSTRAINT provider_limit_rules_no_active_overlap_tiered
        EXCLUDE USING gist (
            provider_id WITH =,
            limit_scope WITH =,
            limit_metric WITH =,
            limit_window WITH =,
            (COALESCE(country_code, '*')) WITH =,
            risk_tier WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE' AND risk_tier IS NOT NULL)
);

COMMENT ON TABLE provider_limit_rules IS
    'Effective-dated provider/contract/platform/user-tier/country limit versions. Replacing '
    'a documented provider value (for example 30 requests/day with 100) is a new approved '
    'rule version with a recorded source, never an application code change (spec §2.1).';
COMMENT ON COLUMN provider_limit_rules.source_reference IS
    'Trusted basis for the value: contract clause, official documentation, written provider '
    'support answer, or approved provider account configuration evidence.';

CREATE INDEX provider_limit_rules_active_idx
    ON provider_limit_rules (provider_id, limit_metric, limit_window, valid_from DESC)
    WHERE status = 'ACTIVE';

CREATE TRIGGER provider_limit_rules_set_updated_at
    BEFORE UPDATE ON provider_limit_rules
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Country / region rules (spec §156I)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_country_rules (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id          UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    country_code         TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    country_group        TEXT NULL,
    eligibility          country_eligibility_status NOT NULL DEFAULT 'INELIGIBLE',
    routing_priority     INTEGER NOT NULL DEFAULT 0,
    reward_rule_group    TEXT NULL,
    campaign_eligible    BOOLEAN NOT NULL DEFAULT false,
    membership_campaign_eligible BOOLEAN NOT NULL DEFAULT false,
    withdrawal_available BOOLEAN NOT NULL DEFAULT true,
    rule_version         INTEGER NOT NULL CHECK (rule_version > 0),
    status               rule_version_status NOT NULL DEFAULT 'DRAFT',
    valid_from           TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to             TIMESTAMPTZ NULL,
    source_reference     TEXT NULL,
    reason               TEXT NULL,
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at          TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_country_rules_version_key
        UNIQUE (provider_id, country_code, rule_version),
    CONSTRAINT provider_country_rules_valid_window
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT provider_country_rules_no_active_overlap
        EXCLUDE USING gist (
            provider_id WITH =,
            country_code WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE')
);

COMMENT ON TABLE provider_country_rules IS
    'Versioned per-provider country behaviour. The authoritative country source and fallback '
    'policy remain a production decision; nothing here treats IP or provider reporting as '
    'authoritative by itself (spec §156I).';

CREATE INDEX provider_country_rules_lookup_idx
    ON provider_country_rules (country_code, provider_id)
    WHERE status = 'ACTIVE';

CREATE TRIGGER provider_country_rules_set_updated_at
    BEFORE UPDATE ON provider_country_rules
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Routing policy versions (spec §156H.3)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_routing_policy_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    policy_version      INTEGER NOT NULL CHECK (policy_version > 0),
    environment         environment_name NOT NULL,
    inputs              JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_weights    JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_routing_policy_versions_key UNIQUE (environment, policy_version),
    CONSTRAINT provider_routing_policy_versions_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE provider_routing_policy_versions IS
    'Auditable routing policy versions. The router selects a provider; it never decides '
    'money and may not bypass caps, country rules or production-approval state.';

-- ---------------------------------------------------------------------------
-- Certification harness results (spec §156G)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_certification_runs (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id          UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    manifest_id          UUID NULL REFERENCES ad_provider_manifests (id) ON DELETE RESTRICT,
    adapter_version      TEXT NOT NULL,
    environment          environment_name NOT NULL,
    run_reference        TEXT NOT NULL,
    overall_status       provider_certification_status NOT NULL DEFAULT 'BLOCKED',
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at          TIMESTAMPTZ NULL,
    notes                TEXT NULL,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_certification_runs_reference_key UNIQUE (provider_id, run_reference)
);

COMMENT ON TABLE provider_certification_runs IS
    'One deterministic certification execution per adapter/manifest version. Production '
    'monetary approval requires a passing run.';

CREATE TABLE provider_certification_results (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    run_id              UUID NOT NULL
                        REFERENCES provider_certification_runs (id) ON DELETE CASCADE,
    case_code           provider_certification_case NOT NULL,
    status              provider_certification_status NOT NULL,
    evidence_reference  TEXT NULL,
    details_redacted    JSONB NOT NULL DEFAULT '{}'::jsonb,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_certification_results_case_key UNIQUE (run_id, case_code)
);

COMMENT ON TABLE provider_certification_results IS
    'Per-case certification evidence: zero duplicate reward, no client-only monetary credit, '
    'no reward on failed/no-fill sessions, deterministic idempotency, no hard-limit bypass.';

CREATE INDEX provider_certification_results_status_idx
    ON provider_certification_results (status, executed_at DESC);

-- ---------------------------------------------------------------------------
-- Settlement and reporting (spec §156N)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_settlement_periods (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id               UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    provider_contract_id      UUID NULL REFERENCES provider_contracts (id) ON DELETE RESTRICT,
    period_start              DATE NOT NULL,
    period_end                DATE NOT NULL,
    settlement_currency       TEXT NOT NULL,
    currency_decimals         SMALLINT NOT NULL CHECK (currency_decimals BETWEEN 0 AND 18),
    estimated_revenue_atomic  BIGINT NOT NULL DEFAULT 0,
    reported_revenue_atomic   BIGINT NULL,
    settled_revenue_atomic    BIGINT NULL,
    invalid_traffic_deduction_atomic BIGINT NOT NULL DEFAULT 0
                              CHECK (invalid_traffic_deduction_atomic >= 0),
    other_adjustments_atomic  BIGINT NOT NULL DEFAULT 0,
    variance_atomic           BIGINT NULL,
    statement_reference       TEXT NULL,
    status                    provider_settlement_status NOT NULL DEFAULT 'OPEN',
    ledger_transaction_id     UUID NULL REFERENCES ledger_transactions (id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_settlement_periods_key UNIQUE (provider_id, period_start, period_end),
    CONSTRAINT provider_settlement_periods_window CHECK (period_end >= period_start)
);

COMMENT ON TABLE provider_settlement_periods IS
    'Reconciles estimated runtime economics to provider statements. Variance and adjustment '
    'amounts may be negative. User ledger history is never rewritten to force a match.';

CREATE INDEX provider_settlement_periods_status_idx
    ON provider_settlement_periods (status, period_start DESC);

CREATE TRIGGER provider_settlement_periods_set_updated_at
    BEFORE UPDATE ON provider_settlement_periods
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE provider_settlement_items (
    id                       UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    settlement_period_id     UUID NOT NULL
                             REFERENCES provider_settlement_periods (id) ON DELETE CASCADE,
    item_date                DATE NOT NULL,
    country_code             TEXT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    ad_unit_id               UUID NULL REFERENCES ad_units (id) ON DELETE SET NULL,
    impressions              BIGINT NOT NULL DEFAULT 0 CHECK (impressions >= 0),
    valid_rewards            BIGINT NOT NULL DEFAULT 0 CHECK (valid_rewards >= 0),
    estimated_revenue_atomic BIGINT NOT NULL DEFAULT 0,
    reported_revenue_atomic  BIGINT NULL,
    variance_atomic          BIGINT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_settlement_items_key
        UNIQUE NULLS NOT DISTINCT (settlement_period_id, item_date, country_code, ad_unit_id)
);

COMMENT ON TABLE provider_settlement_items IS
    'Line-level breakdown of a settlement period by day, country and placement.';

CREATE TRIGGER provider_settlement_items_set_updated_at
    BEFORE UPDATE ON provider_settlement_items
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE provider_reporting_imports (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id          UUID NOT NULL REFERENCES ad_providers (id) ON DELETE RESTRICT,
    settlement_period_id UUID NULL
                         REFERENCES provider_settlement_periods (id) ON DELETE SET NULL,
    source_reference     TEXT NOT NULL,
    import_method        TEXT NOT NULL,
    period_start         DATE NOT NULL,
    period_end           DATE NOT NULL,
    row_count            INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    payload_hash         TEXT NOT NULL,
    status               provider_reporting_import_status NOT NULL DEFAULT 'PENDING',
    error_redacted       TEXT NULL,
    imported_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at         TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT provider_reporting_imports_source_key UNIQUE (provider_id, source_reference)
);

COMMENT ON TABLE provider_reporting_imports IS
    'Idempotent provider reporting ingestion. Imported reporting is an input to '
    'reconciliation, never an authority over the user ledger.';

CREATE INDEX provider_reporting_imports_status_idx
    ON provider_reporting_imports (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Trust snapshots (spec §156K)
-- ---------------------------------------------------------------------------

CREATE TABLE trust_snapshots (
    id            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    trust_state   trust_state NOT NULL,
    trust_score   SMALLINT NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
    rule_version  INTEGER NOT NULL,
    reason_codes  TEXT[] NOT NULL DEFAULT '{}',
    signals       JSONB NOT NULL DEFAULT '{}'::jsonb,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE trust_snapshots IS
    'Versioned positive-history trust snapshots. Trust is not fraud scoring and not '
    'membership: Founder status never creates trusted state, and trust never overrides a '
    'CRITICAL fraud or hard security block (spec §156K).';

CREATE INDEX trust_snapshots_user_idx ON trust_snapshots (user_id, calculated_at DESC);

CREATE TRIGGER trust_snapshots_reject_update
    BEFORE UPDATE ON trust_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER trust_snapshots_reject_delete
    BEFORE DELETE ON trust_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Eligibility decisions (spec §156J)
-- ---------------------------------------------------------------------------

CREATE TABLE eligibility_decisions (
    id             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    action_type    eligibility_action_type NOT NULL,
    outcome        eligibility_outcome NOT NULL,
    provider_id    UUID NULL REFERENCES ad_providers (id) ON DELETE SET NULL,
    ad_session_id  UUID NULL REFERENCES ad_sessions (id) ON DELETE SET NULL,
    mission_version_id UUID NULL REFERENCES mission_versions (id) ON DELETE SET NULL,
    reason_codes   TEXT[] NOT NULL DEFAULT '{}',
    policy_version INTEGER NULL,
    inputs_digest  TEXT NULL,
    safe_inputs    JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE eligibility_decisions IS
    'Persisted typed, reason-coded eligibility outcomes. Eligibility is availability, not '
    'money truth and not fraud scoring. Sensitive fraud rules are never exposed to users.';

CREATE INDEX eligibility_decisions_user_idx
    ON eligibility_decisions (user_id, action_type, decided_at DESC);
CREATE INDEX eligibility_decisions_outcome_idx
    ON eligibility_decisions (outcome, decided_at DESC);

CREATE TRIGGER eligibility_decisions_reject_update
    BEFORE UPDATE ON eligibility_decisions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0009_provider_v12_ops')
ON CONFLICT (version) DO NOTHING;

COMMIT;
