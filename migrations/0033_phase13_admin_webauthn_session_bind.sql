-- ALEx Rewards — Phase 13 independent remediation P13-03
-- 0033_phase13_admin_webauthn_session_bind.sql
--
-- Bind WebAuthn challenges to the issuing admin session where applicable
-- (registration / reauth). Login AUTHENTICATION challenges remain session-null.

BEGIN;

ALTER TABLE admin_webauthn_challenges
    ADD COLUMN IF NOT EXISTS admin_session_id UUID NULL
        REFERENCES admin_sessions (id) ON DELETE CASCADE;

COMMENT ON COLUMN admin_webauthn_challenges.admin_session_id IS
    'Issuing admin_sessions.id for REGISTRATION/REAUTH ceremonies. '
    'AUTHENTICATION (login) challenges remain NULL (no session yet).';

-- Existing open REGISTRATION rows without a session cannot be safely bound;
-- they must be expired/consumed by application TTL. New registration requires session.

CREATE INDEX IF NOT EXISTS admin_webauthn_challenges_session_active_idx
    ON admin_webauthn_challenges (admin_session_id, purpose, expires_at DESC)
    WHERE consumed_at IS NULL AND admin_session_id IS NOT NULL;

COMMIT;
