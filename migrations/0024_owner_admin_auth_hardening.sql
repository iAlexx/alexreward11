-- Forward migration 0024: Owner admin auth hardening (TOTP replay + throttle).
-- Additive only. Does not modify financial engines or Recovery logic.
-- Apply only to approved isolated test databases in this remediation task.
-- Operational alex_rewards application requires separate Owner migration approval.

BEGIN;

ALTER TABLE admin_credentials
    ADD COLUMN IF NOT EXISTS totp_last_accepted_step BIGINT NULL
        CHECK (totp_last_accepted_step IS NULL OR totp_last_accepted_step >= 0);

COMMENT ON COLUMN admin_credentials.totp_last_accepted_step IS
    'Last accepted RFC 6238 TOTP counter for this credential. Used to prevent replay '
    'within the validity window. NULL means no code has been accepted yet.';

CREATE TABLE IF NOT EXISTS admin_auth_throttle (
    admin_user_id     UUID PRIMARY KEY REFERENCES admin_users (id) ON DELETE CASCADE,
    failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_until      TIMESTAMPTZ NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_auth_throttle IS
    'Persistent per-Owner authentication attempt throttle for the local Owner admin auth CLI. '
    'Does not store secrets. Lockouts are time-bounded.';

CREATE TRIGGER admin_auth_throttle_set_updated_at
    BEFORE UPDATE ON admin_auth_throttle
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

COMMIT;
