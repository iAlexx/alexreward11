-- ALEx Rewards Phase 17 Step 1
-- 0056_phase17_payout_publication_integrity.sql
-- Payout-publication delivery state machine, lease fields, privacy snapshot, immutability.
-- No production seeds. No Telegram send. No historical backfill. No money.

BEGIN;

DO $$
DECLARE
    incompatible integer;
BEGIN
    SELECT count(*)::int INTO incompatible
    FROM payout_publications
    WHERE status::text NOT IN ('PENDING', 'PUBLISHED', 'FAILED', 'SKIPPED');
    IF incompatible > 0 THEN
        RAISE EXCEPTION
            '0056 refuse: % payout_publications rows have incompatible status values',
            incompatible;
    END IF;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_publication_status') THEN
        CREATE TYPE payout_publication_status AS ENUM (
            'PENDING',
            'SENDING',
            'PUBLISHED',
            'FAILED',
            'AMBIGUOUS',
            'SKIPPED'
        );
    END IF;
END;
$$;

COMMENT ON TYPE payout_publication_status IS
    'Phase 17 public payout delivery states. AMBIGUOUS is never auto-retried to SENDING.';

ALTER TABLE payout_publications
    ALTER COLUMN status DROP DEFAULT;

ALTER TABLE payout_publications
    ALTER COLUMN status TYPE payout_publication_status
    USING status::text::payout_publication_status;

ALTER TABLE payout_publications
    ALTER COLUMN status SET DEFAULT 'PENDING'::payout_publication_status;

ALTER TABLE payout_publications
    ADD COLUMN IF NOT EXISTS lease_owner TEXT NULL,
    ADD COLUMN IF NOT EXISTS lease_token UUID NULL,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS sending_started_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS ambiguous_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS identity_frozen_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS username_snapshot TEXT NULL;

COMMENT ON COLUMN payout_publications.attempts IS
    'Count of actual Telegram network send attempts only (not DB polls/claims/renders).';
COMMENT ON COLUMN payout_publications.username_snapshot IS
    'Optional SHOW_USERNAME snapshot without @ prefix. NULL => Anonymous User. Never wallet/PII.';
COMMENT ON COLUMN payout_publications.telegram_publication_id IS
    'Optional legacy FK to generic telegram_publications. Phase17 delivery truth remains payout_publications.';
COMMENT ON COLUMN payout_publications.next_attempt_at IS
    'Fairness cursor for worker claim ordering. Stale SENDING must not auto-return to PENDING.';

ALTER TABLE payout_publications
    DROP CONSTRAINT IF EXISTS payout_publications_state_fields_chk;
ALTER TABLE payout_publications
    ADD CONSTRAINT payout_publications_state_fields_chk CHECK (
        (
            status = 'PENDING'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
            AND sending_started_at IS NULL
        )
        OR (
            status = 'SENDING'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
            AND sending_started_at IS NOT NULL
            AND lease_owner IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
        )
        OR (
            status = 'FAILED'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
        )
        OR (
            status = 'AMBIGUOUS'::payout_publication_status
            AND published_at IS NULL
            AND ambiguous_at IS NOT NULL
        )
        OR (
            status = 'PUBLISHED'::payout_publication_status
            AND telegram_message_id IS NOT NULL
            AND published_at IS NOT NULL
            AND ambiguous_at IS NULL
        )
        OR (
            status = 'SKIPPED'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
        )
    );

ALTER TABLE payout_publications
    DROP CONSTRAINT IF EXISTS payout_publications_hide_username_chk;
ALTER TABLE payout_publications
    ADD CONSTRAINT payout_publications_hide_username_chk CHECK (
        identity_mode <> 'HIDE_IDENTITY'::public_payout_identity_mode
        OR username_snapshot IS NULL
    );

CREATE OR REPLACE FUNCTION app_payout_publications_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'payout_publications rows are append-only (DELETE rejected)'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS payout_publications_reject_delete ON payout_publications;
CREATE TRIGGER payout_publications_reject_delete
    BEFORE DELETE ON payout_publications
    FOR EACH ROW EXECUTE FUNCTION app_payout_publications_reject_delete();

CREATE OR REPLACE FUNCTION app_payout_publications_enforce_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    allowed boolean := false;
BEGIN
    IF NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id THEN
        RAISE EXCEPTION 'payout_publications.withdrawal_id is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.destination_id IS DISTINCT FROM OLD.destination_id THEN
        RAISE EXCEPTION 'payout_publications.destination_id is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'payout_publications.created_at is immutable'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD.identity_mode = 'HIDE_IDENTITY'::public_payout_identity_mode
       AND NEW.identity_mode = 'SHOW_USERNAME'::public_payout_identity_mode THEN
        RAISE EXCEPTION 'payout_publications identity cannot escalate HIDE_IDENTITY to SHOW_USERNAME'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.identity_mode = 'SHOW_USERNAME'::public_payout_identity_mode
       AND NEW.identity_mode = 'HIDE_IDENTITY'::public_payout_identity_mode THEN
        IF OLD.status IN (
            'PUBLISHED'::payout_publication_status,
            'SKIPPED'::payout_publication_status
        ) THEN
            RAISE EXCEPTION 'terminal payout_publications identity_mode is immutable'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        NEW.username_snapshot := NULL;
    END IF;

    IF OLD.status = 'PUBLISHED'::payout_publication_status THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.telegram_message_id IS DISTINCT FROM OLD.telegram_message_id
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.identity_mode IS DISTINCT FROM OLD.identity_mode
           OR NEW.username_snapshot IS DISTINCT FROM OLD.username_snapshot
           OR NEW.telegram_publication_id IS DISTINCT FROM OLD.telegram_publication_id THEN
            RAISE EXCEPTION 'PUBLISHED payout_publications rows are immutable'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'SKIPPED'::payout_publication_status THEN
        IF NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'SKIPPED payout_publications status is terminal'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'PENDING'::payout_publication_status
       AND NEW.status IN (
           'SENDING'::payout_publication_status,
           'SKIPPED'::payout_publication_status
       ) THEN
        allowed := true;
    ELSIF OLD.status = 'FAILED'::payout_publication_status
       AND NEW.status IN (
           'SENDING'::payout_publication_status,
           'SKIPPED'::payout_publication_status
       ) THEN
        allowed := true;
    ELSIF OLD.status = 'SENDING'::payout_publication_status
       AND NEW.status IN (
           'PUBLISHED'::payout_publication_status,
           'FAILED'::payout_publication_status,
           'AMBIGUOUS'::payout_publication_status
       ) THEN
        allowed := true;
    ELSIF OLD.status = 'AMBIGUOUS'::payout_publication_status
       AND NEW.status = 'PUBLISHED'::payout_publication_status
       AND NEW.telegram_message_id IS NOT NULL THEN
        allowed := true;
    END IF;

    IF NOT allowed THEN
        RAISE EXCEPTION
            'illegal payout_publications status transition: % -> %',
            OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.status = 'SENDING'::payout_publication_status
       AND OLD.status IN (
           'PENDING'::payout_publication_status,
           'FAILED'::payout_publication_status
       ) THEN
        IF NEW.identity_frozen_at IS NULL THEN
            NEW.identity_frozen_at := now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_payout_publications_enforce_update() IS
    'Phase 17 Step 1: payout publication transition/immutability/privacy guards. AMBIGUOUS never auto-retries to SENDING.';

DROP TRIGGER IF EXISTS payout_publications_enforce_update ON payout_publications;
CREATE TRIGGER payout_publications_enforce_update
    BEFORE UPDATE ON payout_publications
    FOR EACH ROW EXECUTE FUNCTION app_payout_publications_enforce_update();

CREATE INDEX IF NOT EXISTS payout_publications_claim_idx
    ON payout_publications (status, next_attempt_at, created_at);

INSERT INTO schema_migrations (version)
VALUES ('0056_phase17_payout_publication_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
