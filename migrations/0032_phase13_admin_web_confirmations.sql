-- ALEx Rewards — Phase 13 independent remediation P13-01
-- 0032_phase13_admin_web_confirmations.sql
--
-- Server-issued, one-time Admin Web high-impact confirmations.
-- Client-forged HighImpactConfirmationBinding material must NOT authorize.
-- Distinct from Phase 8 admin_action_tokens (Telegram destination/chat bindings).

BEGIN;

CREATE TABLE admin_web_confirmations (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id       UUID NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    admin_session_id    UUID NOT NULL REFERENCES admin_sessions (id) ON DELETE CASCADE,
    action_type         TEXT NOT NULL,
    resource_type       TEXT NOT NULL,
    resource_id         TEXT NOT NULL,
    expected_version    TEXT NOT NULL,
    payload_digest      TEXT NOT NULL,
    nonce               TEXT NOT NULL,
    phrase_hash         TEXT NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    confirmed_at        TIMESTAMPTZ NULL,
    consumed_at         TIMESTAMPTZ NULL,
    CONSTRAINT admin_web_confirmations_nonce_key UNIQUE (nonce),
    CONSTRAINT admin_web_confirmations_ttl CHECK (expires_at > issued_at),
    CONSTRAINT admin_web_confirmations_confirm_order CHECK (
        confirmed_at IS NULL OR confirmed_at >= issued_at
    ),
    CONSTRAINT admin_web_confirmations_consume_order CHECK (
        consumed_at IS NULL
        OR (confirmed_at IS NOT NULL AND consumed_at >= confirmed_at)
    )
);

COMMENT ON TABLE admin_web_confirmations IS
    'Server-issued Admin Web high-impact confirmations. Prepare → confirm phrase → '
    'one-time consume on the mutation. Never store raw session tokens or plaintext phrases.';

COMMENT ON COLUMN admin_web_confirmations.payload_digest IS
    'SHA-256 hex of server-canonicalized mutation payload (not client-supplied hash authority).';

COMMENT ON COLUMN admin_web_confirmations.phrase_hash IS
    'SHA-256 hex of confirmation phrase; plaintext returned once at prepare only.';

CREATE INDEX admin_web_confirmations_session_open_idx
    ON admin_web_confirmations (admin_session_id, expires_at DESC)
    WHERE consumed_at IS NULL;

CREATE INDEX admin_web_confirmations_admin_open_idx
    ON admin_web_confirmations (admin_user_id, expires_at DESC)
    WHERE consumed_at IS NULL;

COMMIT;
