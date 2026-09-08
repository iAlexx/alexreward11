-- ALEx Rewards — Phase 2 Database Baseline
-- 0006_risk_referral_tasks_missions.sql
--
-- Scope: versioned risk rules, risk profiles/snapshots/events, fraud flags,
-- wallet relationships, privacy-conscious network signals, referral graph,
-- V1 tasks and the generic mission engine schema.
--
-- Authority notes:
--   * Risk is assessment, not money. Every monetary effect still flows through
--     the reward/withdrawal engines and the ledger.
--   * Mission/task conditions are typed and allowlisted. There is no generic
--     executable-rule or eval schema anywhere in this baseline.
--   * Admin foreign keys are attached in migration 0007.

BEGIN;

-- ---------------------------------------------------------------------------
-- Risk rule versions and profiles (spec §77, §96.0, §96.1)
-- ---------------------------------------------------------------------------

CREATE TABLE risk_rule_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    rule_version        INTEGER NOT NULL CHECK (rule_version > 0),
    -- Band boundaries and signal weights are versioned data, never hardcoded logic.
    thresholds          JSONB NOT NULL DEFAULT '{}'::jsonb,
    signal_weights      JSONB NOT NULL DEFAULT '{}'::jsonb,
    actions             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    audit_reference     TEXT NULL,
    created_by_admin_id UUID NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT risk_rule_versions_version_key UNIQUE (rule_version),
    CONSTRAINT risk_rule_versions_effective_window
        CHECK (effective_to IS NULL OR effective_to > effective_from)
);

COMMENT ON TABLE risk_rule_versions IS
    'Immutable risk rule/threshold/action versions. No single score may create an '
    'automated permanent ban (spec §77).';

CREATE TABLE risk_profiles (
    id            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    score         SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    risk_tier     risk_tier NOT NULL,
    rule_version  INTEGER NOT NULL,
    reason_codes  TEXT[] NOT NULL DEFAULT '{}',
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT risk_profiles_user_key UNIQUE (user_id)
);

COMMENT ON TABLE risk_profiles IS
    'Current normalized 0-100 risk score per user. History lives in risk_snapshots.';

CREATE TRIGGER risk_profiles_set_updated_at
    BEFORE UPDATE ON risk_profiles
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE risk_snapshots (
    id             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    decision_scope eligibility_action_type NOT NULL,
    score          SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
    risk_tier      risk_tier NOT NULL,
    rule_version   INTEGER NOT NULL,
    reason_codes   TEXT[] NOT NULL DEFAULT '{}',
    inputs_digest  TEXT NULL,
    safe_inputs    JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs        JSONB NOT NULL DEFAULT '{}'::jsonb,
    calculated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE risk_snapshots IS
    'Immutable risk decision input/output captured for a reward or withdrawal decision. '
    'Referenced by withdrawals so a decision stays reconstructable (spec §96.1A).';

CREATE INDEX risk_snapshots_user_idx ON risk_snapshots (user_id, calculated_at DESC);

CREATE TRIGGER risk_snapshots_reject_update
    BEFORE UPDATE ON risk_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER risk_snapshots_reject_delete
    BEFORE DELETE ON risk_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- Deferred foreign key from migration 0005.
ALTER TABLE withdrawals
    ADD CONSTRAINT withdrawals_risk_snapshot_fkey
        FOREIGN KEY (risk_snapshot_id) REFERENCES risk_snapshots (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Risk events, fraud flags, relationships, network signals (spec §96.2–§96.5)
-- ---------------------------------------------------------------------------

CREATE TABLE risk_events (
    id           UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    signal_code  TEXT NOT NULL,
    severity     severity_level NOT NULL DEFAULT 'INFO',
    score_delta  SMALLINT NOT NULL DEFAULT 0,
    safe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    rule_version INTEGER NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NULL
);

COMMENT ON TABLE risk_events IS
    'Append-only risk signals. Sensitive fraud rule detail is never exposed to users.';

CREATE INDEX risk_events_user_idx ON risk_events (user_id, created_at DESC);
CREATE INDEX risk_events_active_idx
    ON risk_events (user_id, expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TABLE fraud_flags (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    flag_type         TEXT NOT NULL,
    severity          severity_level NOT NULL DEFAULT 'MEDIUM',
    status            fraud_flag_status NOT NULL DEFAULT 'OPEN',
    details           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at       TIMESTAMPTZ NULL,
    reviewed_by_admin_id UUID NULL,
    CONSTRAINT fraud_flags_review_consistent
        CHECK (
            (status = 'OPEN' AND reviewed_at IS NULL)
            OR (status <> 'OPEN' AND reviewed_at IS NOT NULL)
        )
);

COMMENT ON TABLE fraud_flags IS
    'Operator-visible fraud flags. Every adverse automated action must be auditable (spec §78).';

CREATE INDEX fraud_flags_open_idx ON fraud_flags (status, severity, created_at DESC);
CREATE INDEX fraud_flags_user_idx ON fraud_flags (user_id, created_at DESC);

CREATE TRIGGER fraud_flags_set_updated_at
    BEFORE UPDATE ON fraud_flags
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE wallet_relationships (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    relationship_type wallet_relationship_type NOT NULL,
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    related_user_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    network_id        UUID NULL REFERENCES networks (id) ON DELETE SET NULL,
    shared_address    TEXT NULL,
    occurrences       INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT wallet_relationships_pair_key
        UNIQUE NULLS NOT DISTINCT (relationship_type, user_id, related_user_id, shared_address),
    CONSTRAINT wallet_relationships_distinct_users CHECK (user_id <> related_user_id)
);

COMMENT ON TABLE wallet_relationships IS
    'Detected links such as repeated payout wallets. Wallet reuse is evidence for review, '
    'never an automatic ban (spec §96.4).';

CREATE INDEX wallet_relationships_related_idx ON wallet_relationships (related_user_id);

CREATE TRIGGER wallet_relationships_set_updated_at
    BEFORE UPDATE ON wallet_relationships
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE network_signals (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    signal_type       TEXT NOT NULL,
    ip_hash           TEXT NULL,
    asn               INTEGER NULL,
    country_code      TEXT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    connection_class  TEXT NULL,
    user_agent_summary TEXT NULL,
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE network_signals IS
    'Privacy-conscious network metadata only (hashed IP, ASN, coarse country). '
    'Precise geolocation is never stored (spec §96.5, §117).';

CREATE INDEX network_signals_user_idx ON network_signals (user_id, observed_at DESC);
CREATE INDEX network_signals_ip_hash_idx ON network_signals (ip_hash) WHERE ip_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Referral V1 (spec §79–§82, §97)
-- ---------------------------------------------------------------------------

CREATE TABLE referral_codes (
    id         UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code       TEXT NOT NULL,
    status     activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_codes_user_key UNIQUE (user_id),
    CONSTRAINT referral_codes_code_key UNIQUE (code)
);

COMMENT ON TABLE referral_codes IS 'One referral code per user (level 1 referral only in V1).';

CREATE TRIGGER referral_codes_set_updated_at
    BEFORE UPDATE ON referral_codes
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE referral_edges (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    referrer_user_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    referred_user_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    code_id                 UUID NOT NULL REFERENCES referral_codes (id) ON DELETE RESTRICT,
    state                   referral_edge_state NOT NULL DEFAULT 'PENDING',
    activation_rule_version INTEGER NULL,
    attributed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at            TIMESTAMPTZ NULL,
    rejected_at             TIMESTAMPTZ NULL,
    rejection_reason        TEXT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- An invitee can be attributed exactly once, ever.
    CONSTRAINT referral_edges_referred_user_key UNIQUE (referred_user_id),
    CONSTRAINT referral_edges_no_self_referral CHECK (referrer_user_id <> referred_user_id)
);

COMMENT ON TABLE referral_edges IS
    'Level-1 referral attribution. Activation requires the versioned activation rule; '
    'the invitee reward is never reduced to fund the referrer (spec §81).';

CREATE INDEX referral_edges_referrer_idx ON referral_edges (referrer_user_id, state);

CREATE TRIGGER referral_edges_set_updated_at
    BEFORE UPDATE ON referral_edges
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE referral_reward_events (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    referral_edge_id        UUID NOT NULL REFERENCES referral_edges (id) ON DELETE RESTRICT,
    referrer_user_id        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    source_reward_event_id  UUID NOT NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    referrer_reward_event_id UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    rate_bps                INTEGER NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
    rule_version            INTEGER NOT NULL,
    amount_atomic           BIGINT NOT NULL CHECK (amount_atomic > 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One referrer bonus per originating eligible reward.
    CONSTRAINT referral_reward_events_source_key
        UNIQUE (referral_edge_id, source_reward_event_id),
    CONSTRAINT referral_reward_events_referrer_reward_key UNIQUE (referrer_reward_event_id)
);

COMMENT ON TABLE referral_reward_events IS
    'Links a referrer bonus to the originating eligible reward. rate_bps is pinned from the '
    'versioned referral rule (Founder profiles use a different versioned rate).';

CREATE INDEX referral_reward_events_referrer_idx
    ON referral_reward_events (referrer_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tasks V1 (spec §83, §98)
-- ---------------------------------------------------------------------------

CREATE TABLE task_definitions (
    id         UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code       TEXT NOT NULL,
    name_key   TEXT NOT NULL,
    status     content_status NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_definitions_code_key UNIQUE (code)
);

COMMENT ON TABLE task_definitions IS
    'Stable task identity. Reward/evaluation rules live in versioned rows (spec §98).';

CREATE TRIGGER task_definitions_set_updated_at
    BEFORE UPDATE ON task_definitions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE task_definition_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    task_definition_id  UUID NOT NULL REFERENCES task_definitions (id) ON DELETE CASCADE,
    task_version        INTEGER NOT NULL CHECK (task_version > 0),
    description_key     TEXT NULL,
    condition_type      mission_condition_type NOT NULL,
    target              INTEGER NOT NULL CHECK (target > 0),
    reset_policy        mission_reset_policy NOT NULL DEFAULT 'NONE',
    reward_rule_id      UUID NULL REFERENCES reward_rules (id) ON DELETE RESTRICT,
    eligibility_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    start_at            TIMESTAMPTZ NULL,
    end_at              TIMESTAMPTZ NULL,
    created_by_admin_id UUID NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_definition_versions_version_key UNIQUE (task_definition_id, task_version),
    CONSTRAINT task_definition_versions_window CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at)
);

COMMENT ON TABLE task_definition_versions IS
    'Versioned task rules. Conditions are typed/allowlisted; no executable rule bodies.';

CREATE TRIGGER task_definition_versions_set_updated_at
    BEFORE UPDATE ON task_definition_versions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE user_task_progress (
    id                       UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                  UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    task_definition_version_id UUID NOT NULL
                             REFERENCES task_definition_versions (id) ON DELETE RESTRICT,
    period_key               TEXT NOT NULL DEFAULT 'LIFETIME',
    progress_count           INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
    target                   INTEGER NOT NULL CHECK (target > 0),
    state                    task_progress_state NOT NULL DEFAULT 'NOT_STARTED',
    started_at               TIMESTAMPTZ NULL,
    completed_at             TIMESTAMPTZ NULL,
    claimed_at               TIMESTAMPTZ NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_task_progress_period_key
        UNIQUE (user_id, task_definition_version_id, period_key)
);

COMMENT ON TABLE user_task_progress IS
    'Server-verified task progress. Client-reported progress alone never awards money.';

CREATE INDEX user_task_progress_user_state_idx ON user_task_progress (user_id, state);

CREATE TRIGGER user_task_progress_set_updated_at
    BEFORE UPDATE ON user_task_progress
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE task_reward_events (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_task_progress_id UUID NOT NULL REFERENCES user_task_progress (id) ON DELETE RESTRICT,
    reward_event_id       UUID NOT NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_reward_events_progress_key UNIQUE (user_task_progress_id),
    CONSTRAINT task_reward_events_reward_key UNIQUE (reward_event_id)
);

COMMENT ON TABLE task_reward_events IS
    'Bridge from a completed task claim to the reward engine result. One reward per claim.';

-- ---------------------------------------------------------------------------
-- Generic mission engine (spec §156P)
-- ---------------------------------------------------------------------------

CREATE TABLE mission_definitions (
    id         UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code       TEXT NOT NULL,
    name_key   TEXT NOT NULL,
    status     content_status NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_definitions_code_key UNIQUE (code)
);

COMMENT ON TABLE mission_definitions IS
    'Stable mission identity. Founder-exclusive missions use membership eligibility rather '
    'than a duplicated task engine.';

CREATE TRIGGER mission_definitions_set_updated_at
    BEFORE UPDATE ON mission_definitions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE mission_versions (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_definition_id UUID NOT NULL REFERENCES mission_definitions (id) ON DELETE CASCADE,
    mission_version       INTEGER NOT NULL CHECK (mission_version > 0),
    name_key              TEXT NOT NULL,
    description_key       TEXT NULL,
    condition_type        mission_condition_type NOT NULL,
    target                INTEGER NOT NULL CHECK (target > 0),
    reset_policy          mission_reset_policy NOT NULL DEFAULT 'NONE',
    eligibility_policy    JSONB NOT NULL DEFAULT '{}'::jsonb,
    required_membership_plan_id UUID NULL,
    reward_source_type    reward_source_type NOT NULL DEFAULT 'MISSION',
    reward_rule_id        UUID NULL REFERENCES reward_rules (id) ON DELETE RESTRICT,
    status                rule_version_status NOT NULL DEFAULT 'DRAFT',
    start_at              TIMESTAMPTZ NULL,
    end_at                TIMESTAMPTZ NULL,
    created_by_admin_id   UUID NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_versions_version_key UNIQUE (mission_definition_id, mission_version),
    CONSTRAINT mission_versions_window CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at)
);

COMMENT ON TABLE mission_versions IS
    'Versioned mission rules using typed allowlisted conditions. required_membership_plan_id '
    'gains its foreign key in migration 0008.';

CREATE INDEX mission_versions_active_idx
    ON mission_versions (status, start_at, end_at);

CREATE TRIGGER mission_versions_set_updated_at
    BEFORE UPDATE ON mission_versions
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE mission_progress (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_version_id UUID NOT NULL REFERENCES mission_versions (id) ON DELETE RESTRICT,
    user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    period_key         TEXT NOT NULL DEFAULT 'LIFETIME',
    progress_count     INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
    target             INTEGER NOT NULL CHECK (target > 0),
    state              task_progress_state NOT NULL DEFAULT 'NOT_STARTED',
    started_at         TIMESTAMPTZ NULL,
    completed_at       TIMESTAMPTZ NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_progress_period_key UNIQUE (mission_version_id, user_id, period_key)
);

COMMENT ON TABLE mission_progress IS
    'Server-verified mission progress per reset period. Client events alone award nothing.';

CREATE INDEX mission_progress_user_idx ON mission_progress (user_id, state);

CREATE TRIGGER mission_progress_set_updated_at
    BEFORE UPDATE ON mission_progress
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE mission_claims (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_version_id  UUID NOT NULL REFERENCES mission_versions (id) ON DELETE RESTRICT,
    mission_progress_id UUID NULL REFERENCES mission_progress (id) ON DELETE RESTRICT,
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    period_key          TEXT NOT NULL DEFAULT 'LIFETIME',
    status              mission_claim_status NOT NULL DEFAULT 'PENDING',
    reward_event_id     UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    rejection_reason    TEXT NULL,
    claimed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_at          TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_claims_period_key UNIQUE (mission_version_id, user_id, period_key),
    CONSTRAINT mission_claims_reward_key UNIQUE (reward_event_id)
);

COMMENT ON TABLE mission_claims IS
    'One claim per mission version, user and period. Monetary rewards always route through '
    'the reward engine and the immutable ledger.';

CREATE TRIGGER mission_claims_set_updated_at
    BEFORE UPDATE ON mission_claims
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0006_risk_referral_tasks_missions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
