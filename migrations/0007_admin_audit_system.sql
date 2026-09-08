-- ALEx Rewards — Phase 2 Database Baseline
-- 0007_admin_audit_system.sql
--
-- Scope: admin identity/RBAC/credentials/sessions/action tokens, the append-only
-- audit log, Telegram destinations and publications, payout publications, the
-- transactional Outbox/Inbox, idempotency keys and versioned system config.
--
-- Naming clarification: spec §99 lists `roles`, `permissions` and
-- `admin_role_bindings`. They are created here as `admin_roles`,
-- `admin_permissions`, `admin_role_permissions` and `admin_role_bindings` so the
-- admin authority family stays unambiguous in a single shared schema. Semantics
-- are unchanged.
--
-- Authority notes:
--   * Admin authentication is fully independent from user Telegram auth.
--   * Only verifiers/hashes/secret-manager references are stored, never secrets.
--   * audit_logs and the Outbox/Inbox are append-only operational truth.

BEGIN;

-- ---------------------------------------------------------------------------
-- Admin identity and RBAC (spec §66, §67, §99)
-- ---------------------------------------------------------------------------

CREATE TABLE admin_users (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    email                  TEXT NOT NULL,
    display_name           TEXT NOT NULL,
    status                 admin_status NOT NULL DEFAULT 'ACTIVE',
    telegram_user_id       BIGINT NULL,
    last_login_at          TIMESTAMPTZ NULL,
    last_reauthenticated_at TIMESTAMPTZ NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at            TIMESTAMPTZ NULL,
    CONSTRAINT admin_users_email_key UNIQUE (email),
    CONSTRAINT admin_users_telegram_user_id_key UNIQUE (telegram_user_id)
);

COMMENT ON TABLE admin_users IS
    'Administrative operators. V1 has exactly one Owner but the model stays general.';

CREATE TRIGGER admin_users_set_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE admin_roles (
    id          UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code        admin_role_code NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NULL,
    status      activation_status NOT NULL DEFAULT 'DISABLED',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_roles_code_key UNIQUE (code)
);

COMMENT ON TABLE admin_roles IS 'RBAC roles (spec §67 `roles`). Only OWNER is enabled in V1.';

CREATE TRIGGER admin_roles_set_updated_at
    BEFORE UPDATE ON admin_roles
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE admin_permissions (
    id          UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code        TEXT NOT NULL,
    description TEXT NULL,
    is_high_impact BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_permissions_code_key UNIQUE (code)
);

COMMENT ON TABLE admin_permissions IS
    'Named permissions (spec §67 `permissions`). is_high_impact drives mandatory '
    'reauthentication and second confirmation.';

CREATE TABLE admin_role_permissions (
    role_id       UUID NOT NULL REFERENCES admin_roles (id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES admin_permissions (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);

COMMENT ON TABLE admin_role_permissions IS 'Role to permission grants.';

CREATE TABLE admin_role_bindings (
    id            UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    role_id       UUID NOT NULL REFERENCES admin_roles (id) ON DELETE RESTRICT,
    granted_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at    TIMESTAMPTZ NULL,
    CONSTRAINT admin_role_bindings_key UNIQUE (admin_user_id, role_id)
);

COMMENT ON TABLE admin_role_bindings IS 'Admin to role assignments with grant/revoke history.';

CREATE TABLE admin_credentials (
    id                     UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id          UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    credential_type        admin_credential_type NOT NULL,
    label                  TEXT NULL,
    password_verifier      TEXT NULL,
    webauthn_credential_id TEXT NULL,
    webauthn_public_key    TEXT NULL,
    webauthn_sign_count    BIGINT NULL CHECK (webauthn_sign_count >= 0),
    webauthn_aaguid        TEXT NULL,
    totp_secret_reference  TEXT NULL,
    status                 activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at           TIMESTAMPTZ NULL,
    disabled_at            TIMESTAMPTZ NULL,
    CONSTRAINT admin_credentials_webauthn_key UNIQUE (webauthn_credential_id),
    CONSTRAINT admin_credentials_material_matches_type
        CHECK (
            (credential_type = 'PASSWORD'
                AND password_verifier IS NOT NULL
                AND webauthn_credential_id IS NULL
                AND totp_secret_reference IS NULL)
            OR (credential_type = 'WEBAUTHN'
                AND webauthn_credential_id IS NOT NULL
                AND webauthn_public_key IS NOT NULL
                AND password_verifier IS NULL)
            OR (credential_type = 'TOTP'
                AND totp_secret_reference IS NOT NULL
                AND password_verifier IS NULL
                AND webauthn_credential_id IS NULL)
        )
);

COMMENT ON TABLE admin_credentials IS
    'Password verifiers, WebAuthn credential metadata and TOTP secret references only. '
    'TOTP alone is never a complete authentication method (spec §66).';

CREATE INDEX admin_credentials_admin_idx ON admin_credentials (admin_user_id, credential_type);

CREATE TRIGGER admin_credentials_set_updated_at
    BEFORE UPDATE ON admin_credentials
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE admin_recovery_codes (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id      UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    code_verifier_hash TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at        TIMESTAMPTZ NULL,
    consumed_source    actor_source NULL,
    CONSTRAINT admin_recovery_codes_hash_key UNIQUE (code_verifier_hash),
    CONSTRAINT admin_recovery_codes_consumption_consistent
        CHECK ((consumed_at IS NULL) = (consumed_source IS NULL))
);

COMMENT ON TABLE admin_recovery_codes IS
    'One-way recovery code verifiers with immutable consumption history.';

CREATE TABLE admin_sessions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id       UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    session_token_hash  TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    idle_expires_at     TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    reauthenticated_at  TIMESTAMPTZ NULL,
    revoked_at          TIMESTAMPTZ NULL,
    revoked_reason      session_revocation_reason NULL,
    ip_hash             TEXT NULL,
    user_agent_summary  TEXT NULL,
    CONSTRAINT admin_sessions_token_key UNIQUE (session_token_hash),
    CONSTRAINT admin_sessions_expiry_order CHECK (absolute_expires_at >= idle_expires_at)
);

COMMENT ON TABLE admin_sessions IS
    'Admin sessions with idle and absolute timeouts plus recent-reauthentication tracking.';

CREATE INDEX admin_sessions_admin_active_idx
    ON admin_sessions (admin_user_id, absolute_expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE admin_action_tokens (
    id                    UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id         UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    action_type           TEXT NOT NULL,
    resource_type         TEXT NOT NULL,
    resource_id           UUID NULL,
    token_hash            TEXT NOT NULL,
    source                actor_source NOT NULL,
    requires_second_confirmation BOOLEAN NOT NULL DEFAULT false,
    issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ NOT NULL,
    confirmed_at          TIMESTAMPTZ NULL,
    consumed_at           TIMESTAMPTZ NULL,
    consumed_by_admin_id  UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    CONSTRAINT admin_action_tokens_hash_key UNIQUE (token_hash),
    CONSTRAINT admin_action_tokens_ttl CHECK (expires_at > issued_at)
);

COMMENT ON TABLE admin_action_tokens IS
    'Single-use, expiring tokens binding a Telegram/web admin action to one resource. '
    'Repeated clicks resolve to the same committed result (spec §56, §57).';

CREATE INDEX admin_action_tokens_open_idx
    ON admin_action_tokens (admin_user_id, expires_at)
    WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audit log (spec §68)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id      UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    actor_type         actor_type NOT NULL DEFAULT 'ADMIN',
    action_type        TEXT NOT NULL,
    resource_type      TEXT NOT NULL,
    resource_id        UUID NULL,
    before_snapshot    JSONB NULL,
    after_snapshot     JSONB NULL,
    reason             TEXT NULL,
    source             actor_source NOT NULL DEFAULT 'WEB',
    ip_hash            TEXT NULL,
    user_agent_summary TEXT NULL,
    trace_id           TEXT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_logs IS
    'Append-only audit trail with before/after snapshots. Secrets must be redacted by the '
    'writer; UPDATE and DELETE are rejected by trigger.';

CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_admin_idx ON audit_logs (admin_user_id, created_at DESC);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

CREATE TRIGGER audit_logs_reject_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER audit_logs_reject_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Telegram destinations and publications (spec §50–§53, §100)
-- ---------------------------------------------------------------------------

CREATE TABLE telegram_destinations (
    id              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    environment     environment_name NOT NULL,
    purpose         telegram_destination_purpose NOT NULL,
    chat_id         BIGINT NOT NULL,
    topic_thread_id BIGINT NULL,
    title           TEXT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT telegram_destinations_target_key
        UNIQUE NULLS NOT DISTINCT (environment, purpose, chat_id, topic_thread_id)
);

COMMENT ON TABLE telegram_destinations IS
    'Environment-scoped Telegram channels/supergroup topics. Production chat identifiers are '
    'operational configuration and are never seeded into the repository.';

CREATE TRIGGER telegram_destinations_set_updated_at
    BEFORE UPDATE ON telegram_destinations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE telegram_publications (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    destination_id      UUID NOT NULL REFERENCES telegram_destinations (id) ON DELETE RESTRICT,
    subject_type        TEXT NOT NULL,
    subject_id          UUID NULL,
    message_kind        TEXT NOT NULL,
    status              publication_status NOT NULL DEFAULT 'PENDING',
    telegram_message_id BIGINT NULL,
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_redacted TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at        TIMESTAMPTZ NULL,
    CONSTRAINT telegram_publications_subject_key
        UNIQUE NULLS NOT DISTINCT (destination_id, subject_type, subject_id, message_kind)
);

COMMENT ON TABLE telegram_publications IS
    'Idempotent Telegram message delivery records keyed by destination and subject.';

CREATE INDEX telegram_publications_status_idx ON telegram_publications (status, created_at);

CREATE TRIGGER telegram_publications_set_updated_at
    BEFORE UPDATE ON telegram_publications
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE payout_publications (
    id                       UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    withdrawal_id            UUID NOT NULL REFERENCES withdrawals (id) ON DELETE RESTRICT,
    destination_id           UUID NOT NULL REFERENCES telegram_destinations (id) ON DELETE RESTRICT,
    telegram_publication_id  UUID NULL REFERENCES telegram_publications (id) ON DELETE SET NULL,
    identity_mode            public_payout_identity_mode NOT NULL DEFAULT 'HIDE_IDENTITY',
    status                   publication_status NOT NULL DEFAULT 'PENDING',
    telegram_message_id      BIGINT NULL,
    attempts                 INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_redacted      TEXT NULL,
    published_at             TIMESTAMPTZ NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Spec §51 idempotency constraint.
    CONSTRAINT payout_publications_withdrawal_destination_key
        UNIQUE (withdrawal_id, destination_id)
);

COMMENT ON TABLE payout_publications IS
    'Public payout proof publications. Only CONFIRMED withdrawals may publish, and the '
    'message never contains a full wallet address (spec §50).';

CREATE TRIGGER payout_publications_set_updated_at
    BEFORE UPDATE ON payout_publications
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Transactional Outbox / Inbox and idempotency (spec §104, §105)
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_events (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    aggregate_type      TEXT NOT NULL,
    aggregate_id        UUID NULL,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              outbox_event_status NOT NULL DEFAULT 'PENDING',
    available_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_redacted TEXT NULL,
    trace_id            TEXT NULL,
    dedupe_key          TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at       TIMESTAMPTZ NULL,
    CONSTRAINT outbox_events_dedupe_key UNIQUE (dedupe_key)
);

COMMENT ON TABLE outbox_events IS
    'Written in the same transaction as the domain state change. Request handlers never '
    'depend on a non-transactional direct call after commit (spec §105).';

CREATE INDEX outbox_events_dispatch_idx
    ON outbox_events (available_at)
    WHERE status = 'PENDING';
CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);

CREATE TABLE inbox_events (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    source              inbox_source NOT NULL,
    source_reference    TEXT NOT NULL,
    external_event_id   TEXT NULL,
    event_type          TEXT NOT NULL,
    payload_redacted    JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload_hash        TEXT NOT NULL,
    status              inbox_event_status NOT NULL DEFAULT 'RECEIVED',
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error_redacted TEXT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ NULL,
    CONSTRAINT inbox_events_external_key
        UNIQUE NULLS NOT DISTINCT (source, source_reference, external_event_id)
);

COMMENT ON TABLE inbox_events IS
    'Normalized inbound provider/Telegram/chain callbacks stored before idempotent handling. '
    'A stored callback is evidence, never financial truth.';

CREATE INDEX inbox_events_status_idx ON inbox_events (status, received_at);

CREATE TABLE idempotency_keys (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    scope             TEXT NOT NULL,
    idempotency_key   TEXT NOT NULL,
    request_hash      TEXT NOT NULL,
    status            idempotency_status NOT NULL DEFAULT 'IN_PROGRESS',
    user_id           UUID NULL REFERENCES users (id) ON DELETE CASCADE,
    admin_user_id     UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    resource_type     TEXT NULL,
    resource_id       UUID NULL,
    response_snapshot JSONB NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ NULL,
    expires_at        TIMESTAMPTZ NULL,
    CONSTRAINT idempotency_keys_scope_key UNIQUE (scope, idempotency_key)
);

COMMENT ON TABLE idempotency_keys IS
    'Database-backed financial idempotency. A client timeout plus retry returns or recovers '
    'the original committed result rather than repeating the mutation.';

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at)
    WHERE expires_at IS NOT NULL;

CREATE TRIGGER idempotency_keys_set_updated_at
    BEFORE UPDATE ON idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Versioned system configuration (spec §111, §112)
-- ---------------------------------------------------------------------------

CREATE TABLE system_config_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    config_key          TEXT NOT NULL,
    environment         environment_name NOT NULL,
    config_version      INTEGER NOT NULL CHECK (config_version > 0),
    old_value           JSONB NULL,
    new_value           JSONB NOT NULL,
    effective_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason              TEXT NULL,
    source_reference    TEXT NULL,
    changed_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    audit_log_id        UUID NULL REFERENCES audit_logs (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT system_config_versions_key UNIQUE (config_key, environment, config_version)
);

COMMENT ON TABLE system_config_versions IS
    'Immutable configuration change history. Quotes pin the rule version they used so a '
    'later config change never alters an existing valid quote.';

CREATE INDEX system_config_versions_effective_idx
    ON system_config_versions (config_key, environment, effective_at DESC);

CREATE TRIGGER system_config_versions_reject_update
    BEFORE UPDATE ON system_config_versions
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Deferred foreign keys from migrations 0003, 0005 and 0006
-- ---------------------------------------------------------------------------

ALTER TABLE ad_session_signals
    ADD CONSTRAINT ad_session_signals_inbox_event_fkey
        FOREIGN KEY (inbox_event_id) REFERENCES inbox_events (id) ON DELETE SET NULL;

ALTER TABLE ad_provider_events
    ADD CONSTRAINT ad_provider_events_inbox_event_fkey
        FOREIGN KEY (inbox_event_id) REFERENCES inbox_events (id) ON DELETE SET NULL;

ALTER TABLE reward_rules
    ADD CONSTRAINT reward_rules_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE withdrawal_fee_rules
    ADD CONSTRAINT withdrawal_fee_rules_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE withdrawal_limit_rules
    ADD CONSTRAINT withdrawal_limit_rules_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE withdrawal_approvals
    ADD CONSTRAINT withdrawal_approvals_admin_fkey
        FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE RESTRICT,
    ADD CONSTRAINT withdrawal_approvals_action_token_fkey
        FOREIGN KEY (action_token_id) REFERENCES admin_action_tokens (id) ON DELETE SET NULL;

ALTER TABLE risk_rule_versions
    ADD CONSTRAINT risk_rule_versions_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE fraud_flags
    ADD CONSTRAINT fraud_flags_reviewed_by_admin_fkey
        FOREIGN KEY (reviewed_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE task_definition_versions
    ADD CONSTRAINT task_definition_versions_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

ALTER TABLE mission_versions
    ADD CONSTRAINT mission_versions_created_by_admin_fkey
        FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL;

INSERT INTO schema_migrations (version)
VALUES ('0007_admin_audit_system')
ON CONFLICT (version) DO NOTHING;

COMMIT;
