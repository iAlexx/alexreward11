-- ALEx Rewards — Phase 8 Control Center Security Integrity
-- 0019_control_center_security_integrity.sql
--
-- Scope (forward-only; migrations 0001–0018 remain byte-identical):
--   * CONTROL_CENTER_AUDIT and CONTROL_CENTER_SYSTEM destination purposes
--     (Reports continues to use CONTROL_CENTER_DAILY_REPORT)
--   * admin_action_tokens: expected_state, destination/chat/topic binding,
--     nonce/replay binding, optional second-confirmation parent link
--   * Phase 8 named permission catalog bound to OWNER only
--
-- PostgreSQL note: ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL
-- 12+ (CI pins 18.6). IF NOT EXISTS keeps upgrades idempotent when replaying
-- carefully. New enum labels are usable in the same transaction on PG 12+.

BEGIN;

-- ---------------------------------------------------------------------------
-- Destination purposes for approved Forum Topics: Audit + System
-- ---------------------------------------------------------------------------

ALTER TYPE telegram_destination_purpose ADD VALUE IF NOT EXISTS 'CONTROL_CENTER_AUDIT';
ALTER TYPE telegram_destination_purpose ADD VALUE IF NOT EXISTS 'CONTROL_CENTER_SYSTEM';

-- ---------------------------------------------------------------------------
-- Action-token security bindings (spec §55–§58)
-- ---------------------------------------------------------------------------

ALTER TABLE admin_action_tokens
    ADD COLUMN IF NOT EXISTS expected_state TEXT NULL,
    ADD COLUMN IF NOT EXISTS destination_id UUID NULL
        REFERENCES telegram_destinations (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS bound_chat_id BIGINT NULL,
    ADD COLUMN IF NOT EXISTS bound_topic_thread_id BIGINT NULL,
    ADD COLUMN IF NOT EXISTS nonce TEXT NULL,
    ADD COLUMN IF NOT EXISTS confirmation_of_token_id UUID NULL
        REFERENCES admin_action_tokens (id) ON DELETE RESTRICT;

-- Fail closed on upgrade if any pre-Phase-8 open tokens lack bindings.
-- Fresh installs and accepted Phase 7 DBs have zero action-token rows.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM admin_action_tokens
        WHERE destination_id IS NULL
           OR bound_chat_id IS NULL
           OR nonce IS NULL
    ) THEN
        RAISE EXCEPTION
            '0019: admin_action_tokens rows missing destination/chat/nonce bindings; refuse upgrade';
    END IF;
END $$;

ALTER TABLE admin_action_tokens
    ALTER COLUMN destination_id SET NOT NULL,
    ALTER COLUMN bound_chat_id SET NOT NULL,
    ALTER COLUMN nonce SET NOT NULL;

ALTER TABLE admin_action_tokens
    DROP CONSTRAINT IF EXISTS admin_action_tokens_nonce_key;
ALTER TABLE admin_action_tokens
    ADD CONSTRAINT admin_action_tokens_nonce_key UNIQUE (nonce);

CREATE INDEX IF NOT EXISTS admin_action_tokens_destination_open_idx
    ON admin_action_tokens (destination_id, expires_at)
    WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_action_tokens_confirmation_idx
    ON admin_action_tokens (confirmation_of_token_id)
    WHERE confirmation_of_token_id IS NOT NULL;

COMMENT ON COLUMN admin_action_tokens.expected_state IS
    'Authoritative domain state at issuance. Compared server-side on consume; '
    'never trusted from Telegram callback payload.';
COMMENT ON COLUMN admin_action_tokens.destination_id IS
    'telegram_destinations row binding environment + purpose + chat + topic.';
COMMENT ON COLUMN admin_action_tokens.bound_chat_id IS
    'Denormalized chat_id snapshot from destination at issuance for fail-closed compare.';
COMMENT ON COLUMN admin_action_tokens.bound_topic_thread_id IS
    'Denormalized Forum topic thread id (NULL only when destination has no topic).';
COMMENT ON COLUMN admin_action_tokens.nonce IS
    'Unique server nonce for replay protection; distinct from token_hash.';
COMMENT ON COLUMN admin_action_tokens.confirmation_of_token_id IS
    'When set, this token is the second-confirmation step for the parent action token.';

-- ---------------------------------------------------------------------------
-- Phase 8 permission catalog (V1: OWNER role only)
-- ---------------------------------------------------------------------------

INSERT INTO admin_permissions (code, description, is_high_impact)
VALUES
    ('withdrawal.review.decide',
     'Approve, hold, or reject withdrawals via Control Center', false),
    ('review_queue.operate',
     'Assign, comment, escalate, and transition review queue cases', false),
    ('founder.search',
     'Search Founder/member identity and membership summary', false),
    ('founder.grant',
     'Audited direct FOUNDER_LIFETIME Owner grant (verified pre-launch payment)', true),
    ('founder.claim_code.issue',
     'Issue one-time Founder claim codes (hash-at-rest)', true),
    ('founder.history.view',
     'View Founder number and grant/claim history', false),
    ('admin.action.confirm_high_impact',
     'Complete second confirmation for high-impact Control Center actions', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'OWNER'
  AND p.code IN (
      'withdrawal.review.decide',
      'review_queue.operate',
      'founder.search',
      'founder.grant',
      'founder.claim_code.issue',
      'founder.history.view',
      'admin.action.confirm_high_impact'
  )
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0019_control_center_security_integrity')
ON CONFLICT DO NOTHING;

COMMIT;
