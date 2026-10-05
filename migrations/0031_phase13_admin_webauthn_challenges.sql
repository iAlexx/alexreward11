-- ALEx Rewards — Phase 13 Owner Admin WebAuthn challenges
-- 0031_phase13_admin_webauthn_challenges.sql
--
-- Additive only. Stores one-time, expiring WebAuthn registration/authentication
-- challenges for Owner Admin auth. Does NOT invent production RP ID / origin
-- defaults (OWNER_DECISION_REQUIRED via ADMIN_WEBAUTHN_* env).

BEGIN;

CREATE TABLE admin_webauthn_challenges (
    id              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    admin_user_id   UUID NULL REFERENCES admin_users (id) ON DELETE CASCADE,
    purpose         TEXT NOT NULL,
    challenge       TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT admin_webauthn_challenges_purpose_check
        CHECK (purpose IN ('REGISTRATION', 'AUTHENTICATION', 'REAUTH')),
    CONSTRAINT admin_webauthn_challenges_challenge_key UNIQUE (challenge),
    CONSTRAINT admin_webauthn_challenges_ttl CHECK (expires_at > created_at),
    CONSTRAINT admin_webauthn_challenges_registration_requires_admin
        CHECK (
            (purpose = 'REGISTRATION' AND admin_user_id IS NOT NULL)
            OR purpose IN ('AUTHENTICATION', 'REAUTH')
        )
);

COMMENT ON TABLE admin_webauthn_challenges IS
    'One-time WebAuthn ceremony challenges for Owner Admin registration, login, and reauth. '
    'Challenges expire and are consumed exactly once. RP ID / origin are runtime config only.';

CREATE INDEX admin_webauthn_challenges_admin_active_idx
    ON admin_webauthn_challenges (admin_user_id, purpose, expires_at DESC)
    WHERE consumed_at IS NULL;

CREATE INDEX admin_webauthn_challenges_expiry_idx
    ON admin_webauthn_challenges (expires_at)
    WHERE consumed_at IS NULL;

COMMIT;
