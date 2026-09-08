-- ALEx Rewards — Phase 2 Database Baseline
-- 0010_review_notifications_flags_reconciliation.sql
--
-- Scope: in-app support, the unified review queue, notifications and campaigns,
-- feature flags with version history, economic exposure limits and the
-- reconciliation run/item/issue model.
--
-- Authority notes:
--   * The Review Center is an operational projection. Domain systems remain the
--     source of state and money truth; review actions call domain commands.
--   * Support compensation never mutates a balance. It raises a reward/adjustment
--     command that flows through the ledger.
--   * A feature flag may never weaken ledger, reconciliation, signer,
--     authentication, provider hard-limit or legal invariants.

BEGIN;

-- ---------------------------------------------------------------------------
-- Support (spec §89, §101)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE support_ticket_public_id_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE TABLE support_tickets (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    public_id           TEXT NOT NULL
                        DEFAULT 'SUP-' || lpad(nextval('support_ticket_public_id_seq')::text, 6, '0'),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    subject             TEXT NOT NULL,
    category            TEXT NULL,
    state               support_ticket_state NOT NULL DEFAULT 'OPEN',
    priority            priority_level NOT NULL DEFAULT 'NORMAL',
    assigned_admin_id   UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    related_withdrawal_id UUID NULL REFERENCES withdrawals (id) ON DELETE SET NULL,
    related_ad_session_id UUID NULL REFERENCES ad_sessions (id) ON DELETE SET NULL,
    app_version_summary TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at     TIMESTAMPTZ NULL,
    resolved_at         TIMESTAMPTZ NULL,
    closed_at           TIMESTAMPTZ NULL,
    CONSTRAINT support_tickets_public_id_key UNIQUE (public_id)
);

COMMENT ON TABLE support_tickets IS
    'In-app support tickets. Support sees safe context only; financial compensation is a '
    'reward/adjustment command to the ledger, never a direct balance edit (spec §101).';

CREATE INDEX support_tickets_state_idx ON support_tickets (state, priority DESC, created_at);
CREATE INDEX support_tickets_user_idx ON support_tickets (user_id, created_at DESC);

CREATE TRIGGER support_tickets_set_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE support_messages (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    support_ticket_id UUID NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
    author_type       support_author_type NOT NULL,
    author_user_id    UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    author_admin_id   UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    body              TEXT NOT NULL,
    attachments       JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_internal_note  BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT support_messages_author_matches_type
        CHECK (
            (author_type = 'USER' AND author_user_id IS NOT NULL AND author_admin_id IS NULL)
            OR (author_type = 'ADMIN' AND author_admin_id IS NOT NULL AND author_user_id IS NULL)
            OR (author_type = 'SYSTEM' AND author_user_id IS NULL AND author_admin_id IS NULL)
        ),
    CONSTRAINT support_messages_internal_note_is_admin
        CHECK (NOT is_internal_note OR author_type <> 'USER')
);

COMMENT ON TABLE support_messages IS
    'Ticket conversation. Internal notes are never visible to the user.';

CREATE INDEX support_messages_ticket_idx ON support_messages (support_ticket_id, created_at);

CREATE TABLE support_events (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    support_ticket_id UUID NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
    event_type        TEXT NOT NULL,
    actor_type        actor_type NOT NULL DEFAULT 'SYSTEM',
    actor_admin_id    UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    actor_user_id     UUID NULL REFERENCES users (id) ON DELETE SET NULL,
    from_state        support_ticket_state NULL,
    to_state          support_ticket_state NULL,
    details           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE support_events IS 'Append-only ticket lifecycle history.';

CREATE INDEX support_events_ticket_idx ON support_events (support_ticket_id, created_at);

CREATE TRIGGER support_events_reject_update
    BEFORE UPDATE ON support_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Unified review queue (spec §156O)
-- ---------------------------------------------------------------------------

CREATE TABLE review_cases (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    case_type         review_case_type NOT NULL,
    resource_type     TEXT NOT NULL,
    resource_id       UUID NULL,
    priority          priority_level NOT NULL DEFAULT 'NORMAL',
    reason_codes      TEXT[] NOT NULL DEFAULT '{}',
    state             review_case_state NOT NULL DEFAULT 'OPEN',
    assigned_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    summary           TEXT NULL,
    resolution_notes  TEXT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ NULL,
    CONSTRAINT review_cases_resolution_consistent
        CHECK (
            (state IN ('RESOLVED', 'DISMISSED')) = (resolved_at IS NOT NULL)
        )
);

COMMENT ON TABLE review_cases IS
    'Operational control surface over existing domain state. Actions taken here call the '
    'authoritative domain command and must pass its state/permission/invariant checks.';

-- At most one live case per resource and case type.
CREATE UNIQUE INDEX review_cases_one_open_per_resource_idx
    ON review_cases (case_type, resource_type, resource_id)
    WHERE state IN ('OPEN', 'IN_REVIEW', 'WAITING_INPUT', 'ESCALATED');

CREATE INDEX review_cases_queue_idx
    ON review_cases (state, priority DESC, created_at);

CREATE TRIGGER review_cases_set_updated_at
    BEFORE UPDATE ON review_cases
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE review_case_events (
    id             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    review_case_id UUID NOT NULL REFERENCES review_cases (id) ON DELETE CASCADE,
    event_type     review_case_event_type NOT NULL,
    admin_user_id  UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    from_state     review_case_state NULL,
    to_state       review_case_state NULL,
    note           TEXT NULL,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
    audit_log_id   UUID NULL REFERENCES audit_logs (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE review_case_events IS
    'Append-only review history including which domain action was invoked.';

CREATE INDEX review_case_events_case_idx ON review_case_events (review_case_id, created_at);

CREATE TRIGGER review_case_events_reject_update
    BEFORE UPDATE ON review_case_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Notifications and campaigns (spec §90, §156Q)
-- ---------------------------------------------------------------------------

CREATE SEQUENCE notification_campaign_public_id_seq AS BIGINT START WITH 1 INCREMENT BY 1;

CREATE TABLE notification_campaigns (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    public_id             TEXT NOT NULL
                          DEFAULT 'CMP-' || lpad(nextval('notification_campaign_public_id_seq')::text, 6, '0'),
    code                  TEXT NOT NULL,
    title                 TEXT NOT NULL,
    body_key              TEXT NULL,
    channel               notification_channel NOT NULL DEFAULT 'IN_APP',
    category              notification_category NOT NULL DEFAULT 'MARKETING',
    segment_code          notification_segment_code NOT NULL,
    segment_params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                notification_campaign_status NOT NULL DEFAULT 'DRAFT',
    rate_limit_per_minute INTEGER NULL CHECK (rate_limit_per_minute > 0),
    target_count          INTEGER NULL CHECK (target_count >= 0),
    scheduled_at          TIMESTAMPTZ NULL,
    started_at            TIMESTAMPTZ NULL,
    completed_at          TIMESTAMPTZ NULL,
    created_by_admin_id   UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notification_campaigns_public_id_key UNIQUE (public_id),
    CONSTRAINT notification_campaigns_code_key UNIQUE (code),
    -- Mandatory security notifications stay outside the campaign tool.
    CONSTRAINT notification_campaigns_not_security CHECK (category <> 'SECURITY')
);

COMMENT ON TABLE notification_campaigns IS
    'Owner campaign tool over privacy-safe server-side segments. Delivery respects marketing '
    'preferences and rate limits, and campaign copy must never contain balance, wallet, '
    'fraud or security detail (spec §156Q).';

CREATE INDEX notification_campaigns_status_idx
    ON notification_campaigns (status, scheduled_at);

CREATE TRIGGER notification_campaigns_set_updated_at
    BEFORE UPDATE ON notification_campaigns
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id     UUID NULL REFERENCES users (id) ON DELETE CASCADE,
    campaign_id UUID NULL REFERENCES notification_campaigns (id) ON DELETE SET NULL,
    category    notification_category NOT NULL,
    type_code   TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    outbox_event_id UUID NULL REFERENCES outbox_events (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at     TIMESTAMPTZ NULL,
    CONSTRAINT notifications_has_audience CHECK (user_id IS NOT NULL OR campaign_id IS NOT NULL),
    -- One campaign message per user.
    CONSTRAINT notifications_campaign_user_key UNIQUE (campaign_id, user_id)
);

COMMENT ON TABLE notifications IS
    'User-facing notification records for in-app and bot delivery, produced from domain '
    'events through the Outbox.';

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx
    ON notifications (user_id)
    WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    notification_id       UUID NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
    channel               notification_channel NOT NULL,
    destination_id        UUID NULL REFERENCES telegram_destinations (id) ON DELETE SET NULL,
    status                notification_delivery_status NOT NULL DEFAULT 'PENDING',
    provider_message_reference TEXT NULL,
    attempts              INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_redacted   TEXT NULL,
    suppressed_reason     TEXT NULL,
    scheduled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at               TIMESTAMPTZ NULL,
    delivered_at          TIMESTAMPTZ NULL,
    failed_at             TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notification_deliveries_channel_key UNIQUE (notification_id, channel)
);

COMMENT ON TABLE notification_deliveries IS
    'Per-channel delivery state with retries driven by the Outbox. SUPPRESSED records a '
    'preference or rate-limit decision rather than a failure.';

CREATE INDEX notification_deliveries_pending_idx
    ON notification_deliveries (scheduled_at)
    WHERE status = 'PENDING';

CREATE TRIGGER notification_deliveries_set_updated_at
    BEFORE UPDATE ON notification_deliveries
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Feature flags and kill switches (spec §110, §156R)
-- ---------------------------------------------------------------------------

CREATE TABLE feature_flags (
    id          UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    flag_key    TEXT NOT NULL,
    environment environment_name NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT false,
    description TEXT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feature_flags_key UNIQUE (flag_key, environment)
);

COMMENT ON TABLE feature_flags IS
    'Environment-specific flags and kill switches. A flag may never bypass immutable ledger '
    'rules, reconciliation, signer validation, authentication, provider hard limits or '
    'mandatory legal blocks (spec §156R).';

CREATE TRIGGER feature_flags_set_updated_at
    BEFORE UPDATE ON feature_flags
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE feature_flag_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    feature_flag_id     UUID NOT NULL REFERENCES feature_flags (id) ON DELETE CASCADE,
    flag_version        INTEGER NOT NULL CHECK (flag_version > 0),
    old_enabled         BOOLEAN NULL,
    new_enabled         BOOLEAN NOT NULL,
    reason              TEXT NULL,
    effective_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    changed_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    audit_log_id        UUID NULL REFERENCES audit_logs (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT feature_flag_versions_key UNIQUE (feature_flag_id, flag_version)
);

COMMENT ON TABLE feature_flag_versions IS 'Immutable, audited flag change history.';

CREATE TRIGGER feature_flag_versions_reject_update
    BEFORE UPDATE ON feature_flag_versions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Economic exposure limits (spec §156L)
-- ---------------------------------------------------------------------------

CREATE TABLE economic_exposure_limits (
    id                   UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    limit_code           exposure_limit_code NOT NULL,
    environment          environment_name NOT NULL,
    scope_reference_id   UUID NULL,
    country_group        TEXT NULL,
    asset_id             UUID NULL REFERENCES assets (id) ON DELETE RESTRICT,
    limit_atomic         BIGINT NULL CHECK (limit_atomic > 0),
    limit_bps            INTEGER NULL CHECK (limit_bps BETWEEN 0 AND 10000),
    rule_version         INTEGER NOT NULL CHECK (rule_version > 0),
    status               rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to         TIMESTAMPTZ NULL,
    reason               TEXT NULL,
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at          TIMESTAMPTZ NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT economic_exposure_limits_version_key
        UNIQUE NULLS NOT DISTINCT
            (limit_code, environment, scope_reference_id, country_group, rule_version),
    CONSTRAINT economic_exposure_limits_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT economic_exposure_limits_single_value
        CHECK (num_nonnulls(limit_atomic, limit_bps) = 1)
);

COMMENT ON TABLE economic_exposure_limits IS
    'Versioned exposure/circuit-breaker limits. Production values are OWNER_DECISION_REQUIRED '
    'and are never seeded. Reaching a limit stops new affected monetary authorizations; it '
    'never retroactively reduces a valid quote after an ad has validly started.';

CREATE INDEX economic_exposure_limits_active_idx
    ON economic_exposure_limits (limit_code, environment, effective_from DESC)
    WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Reconciliation (spec §48, §102)
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_runs (
    id             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    scope          reconciliation_scope NOT NULL,
    environment    environment_name NOT NULL,
    run_reference  TEXT NOT NULL,
    status         reconciliation_run_status NOT NULL DEFAULT 'RUNNING',
    parameters     JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reconciliation_runs_reference_key UNIQUE (scope, run_reference)
);

COMMENT ON TABLE reconciliation_runs IS
    'Independent verification passes, including rebuilding balance projections from immutable '
    'ledger entries and comparing them with ledger_account_balances.';

CREATE INDEX reconciliation_runs_status_idx ON reconciliation_runs (status, started_at DESC);

CREATE TABLE reconciliation_items (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    reconciliation_run_id  UUID NOT NULL REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
    item_type              TEXT NOT NULL,
    resource_type          TEXT NOT NULL,
    resource_id            UUID NULL,
    asset_id               UUID NULL REFERENCES assets (id) ON DELETE RESTRICT,
    expected_amount_atomic BIGINT NULL,
    observed_amount_atomic BIGINT NULL,
    variance_atomic        BIGINT NULL,
    status                 reconciliation_item_status NOT NULL DEFAULT 'PENDING',
    details                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE reconciliation_items IS
    'Per-resource comparison results. Amounts are signed atomic values because a variance '
    'may legitimately be negative.';

CREATE INDEX reconciliation_items_run_idx
    ON reconciliation_items (reconciliation_run_id, status);
CREATE INDEX reconciliation_items_resource_idx
    ON reconciliation_items (resource_type, resource_id);

CREATE TABLE reconciliation_issues (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    reconciliation_run_id  UUID NULL REFERENCES reconciliation_runs (id) ON DELETE SET NULL,
    reconciliation_item_id UUID NULL REFERENCES reconciliation_items (id) ON DELETE SET NULL,
    issue_code             TEXT NOT NULL,
    severity               reconciliation_issue_severity NOT NULL DEFAULT 'WARNING',
    status                 reconciliation_issue_status NOT NULL DEFAULT 'OPEN',
    resource_type          TEXT NOT NULL,
    resource_id            UUID NULL,
    description            TEXT NOT NULL,
    review_case_id         UUID NULL REFERENCES review_cases (id) ON DELETE SET NULL,
    opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at            TIMESTAMPTZ NULL,
    resolved_by_admin_id   UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    resolution_notes       TEXT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reconciliation_issues_resolution_consistent
        CHECK ((status IN ('RESOLVED', 'DISMISSED')) = (resolved_at IS NOT NULL))
);

COMMENT ON TABLE reconciliation_issues IS
    'An unresolved CRITICAL financial issue can trigger the payout circuit breaker. '
    'Resolution never rewrites ledger history.';

CREATE INDEX reconciliation_issues_open_critical_idx
    ON reconciliation_issues (severity, opened_at)
    WHERE status IN ('OPEN', 'INVESTIGATING');

CREATE TRIGGER reconciliation_issues_set_updated_at
    BEFORE UPDATE ON reconciliation_issues
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

INSERT INTO schema_migrations (version)
VALUES ('0010_review_notifications_flags_reconciliation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
