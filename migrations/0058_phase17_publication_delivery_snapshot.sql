-- ALEx Rewards Phase 17 Step 2
-- 0058_phase17_publication_delivery_snapshot.sql
-- Delivery snapshot columns + tighter state-field CHECK + freeze rules for send/message/explorer.
-- No seeds. No Telegram send. No historical backfill. No money.

BEGIN;

ALTER TABLE payout_publications
    ADD COLUMN IF NOT EXISTS send_request_started_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS message_text_snapshot TEXT NULL,
    ADD COLUMN IF NOT EXISTS explorer_url_snapshot TEXT NULL;

COMMENT ON COLUMN payout_publications.send_request_started_at IS
    'Set when the live Telegram send HTTP request begins (Step 3+). Frozen after start.';
COMMENT ON COLUMN payout_publications.message_text_snapshot IS
    'Exact public message text frozen at SENDING entry. Retained through AMBIGUOUS/PUBLISHED.';
COMMENT ON COLUMN payout_publications.explorer_url_snapshot IS
    'Exact https explorer URL frozen at SENDING entry. Retained through AMBIGUOUS/PUBLISHED.';

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
            AND identity_frozen_at IS NULL
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND send_request_started_at IS NULL
            AND message_text_snapshot IS NULL
            AND explorer_url_snapshot IS NULL
        )
        OR (
            status = 'FAILED'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
            AND sending_started_at IS NULL
            AND identity_frozen_at IS NULL
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND send_request_started_at IS NULL
            AND message_text_snapshot IS NULL
            AND explorer_url_snapshot IS NULL
        )
        OR (
            status = 'SKIPPED'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
            AND sending_started_at IS NULL
            AND identity_frozen_at IS NULL
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND send_request_started_at IS NULL
            AND message_text_snapshot IS NULL
            AND explorer_url_snapshot IS NULL
        )
        OR (
            status = 'SENDING'::payout_publication_status
            AND telegram_message_id IS NULL
            AND published_at IS NULL
            AND ambiguous_at IS NULL
            AND sending_started_at IS NOT NULL
            AND identity_frozen_at IS NOT NULL
            AND lease_owner IS NOT NULL
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND message_text_snapshot IS NOT NULL
            AND explorer_url_snapshot IS NOT NULL
        )
        OR (
            status = 'AMBIGUOUS'::payout_publication_status
            AND published_at IS NULL
            AND ambiguous_at IS NOT NULL
            AND identity_frozen_at IS NOT NULL
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND send_request_started_at IS NOT NULL
            AND message_text_snapshot IS NOT NULL
            AND explorer_url_snapshot IS NOT NULL
        )
        OR (
            status = 'PUBLISHED'::payout_publication_status
            AND telegram_message_id IS NOT NULL
            AND published_at IS NOT NULL
            AND ambiguous_at IS NULL
            AND identity_frozen_at IS NOT NULL
            AND lease_owner IS NULL
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
            AND send_request_started_at IS NOT NULL
            AND message_text_snapshot IS NOT NULL
            AND explorer_url_snapshot IS NOT NULL
        )
    );

CREATE OR REPLACE FUNCTION app_payout_publications_enforce_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    allowed boolean := false;
    clearing_failed boolean := false;
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

    -- Identity is frozen once a real send attempt has started (or terminal skip/publish).
    IF OLD.status IN (
        'SENDING'::payout_publication_status,
        'AMBIGUOUS'::payout_publication_status,
        'PUBLISHED'::payout_publication_status,
        'SKIPPED'::payout_publication_status
    ) THEN
        IF NEW.identity_mode IS DISTINCT FROM OLD.identity_mode
           OR NEW.username_snapshot IS DISTINCT FROM OLD.username_snapshot THEN
            RAISE EXCEPTION 'payout_publications identity snapshot is frozen after send attempt'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF OLD.identity_mode = 'HIDE_IDENTITY'::public_payout_identity_mode
       AND NEW.identity_mode = 'SHOW_USERNAME'::public_payout_identity_mode THEN
        RAISE EXCEPTION 'payout_publications identity cannot escalate HIDE_IDENTITY to SHOW_USERNAME'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Pre-send / definite-no-message retryable states may become more private.
    IF OLD.identity_mode = 'SHOW_USERNAME'::public_payout_identity_mode
       AND NEW.identity_mode = 'HIDE_IDENTITY'::public_payout_identity_mode THEN
        IF OLD.status NOT IN (
            'PENDING'::payout_publication_status,
            'FAILED'::payout_publication_status
        ) THEN
            RAISE EXCEPTION 'payout_publications identity cannot downgrade outside PENDING/FAILED'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        NEW.username_snapshot := NULL;
    END IF;

    clearing_failed := (
        OLD.status = 'SENDING'::payout_publication_status
        AND NEW.status = 'FAILED'::payout_publication_status
    );

    -- Freeze delivery timestamps/snapshots after SENDING (except intentional FAILED clear).
    IF OLD.status IN (
        'SENDING'::payout_publication_status,
        'AMBIGUOUS'::payout_publication_status,
        'PUBLISHED'::payout_publication_status
    ) AND NOT clearing_failed THEN
        IF NEW.identity_frozen_at IS DISTINCT FROM OLD.identity_frozen_at
           OR NEW.sending_started_at IS DISTINCT FROM OLD.sending_started_at
           OR NEW.message_text_snapshot IS DISTINCT FROM OLD.message_text_snapshot
           OR NEW.explorer_url_snapshot IS DISTINCT FROM OLD.explorer_url_snapshot THEN
            RAISE EXCEPTION 'payout_publications delivery snapshot fields are frozen after send attempt'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- send_request_started_at: allow first set (NULL -> value) while SENDING only.
        IF OLD.send_request_started_at IS NOT NULL
           AND NEW.send_request_started_at IS DISTINCT FROM OLD.send_request_started_at THEN
            RAISE EXCEPTION 'payout_publications.send_request_started_at is frozen after set'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN (
            'AMBIGUOUS'::payout_publication_status,
            'PUBLISHED'::payout_publication_status
        ) THEN
            IF NEW.send_request_started_at IS DISTINCT FROM OLD.send_request_started_at THEN
                RAISE EXCEPTION 'payout_publications.send_request_started_at is frozen after send attempt'
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        END IF;
    END IF;

    IF OLD.status = 'PUBLISHED'::payout_publication_status THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.telegram_message_id IS DISTINCT FROM OLD.telegram_message_id
           OR NEW.published_at IS DISTINCT FROM OLD.published_at
           OR NEW.telegram_publication_id IS DISTINCT FROM OLD.telegram_publication_id
           OR NEW.sending_started_at IS DISTINCT FROM OLD.sending_started_at
           OR NEW.identity_frozen_at IS DISTINCT FROM OLD.identity_frozen_at
           OR NEW.send_request_started_at IS DISTINCT FROM OLD.send_request_started_at
           OR NEW.message_text_snapshot IS DISTINCT FROM OLD.message_text_snapshot
           OR NEW.explorer_url_snapshot IS DISTINCT FROM OLD.explorer_url_snapshot THEN
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
        -- DB owns freeze/send-start clocks; ignore caller-supplied values.
        NEW.identity_frozen_at := now();
        NEW.sending_started_at := now();
    END IF;

    IF OLD.status = 'SENDING'::payout_publication_status
       AND NEW.status = 'FAILED'::payout_publication_status THEN
        NEW.identity_frozen_at := NULL;
        NEW.sending_started_at := NULL;
        NEW.lease_owner := NULL;
        NEW.lease_token := NULL;
        NEW.lease_expires_at := NULL;
        NEW.send_request_started_at := NULL;
        NEW.message_text_snapshot := NULL;
        NEW.explorer_url_snapshot := NULL;
    END IF;

    IF OLD.status = 'SENDING'::payout_publication_status
       AND NEW.status IN (
           'AMBIGUOUS'::payout_publication_status,
           'PUBLISHED'::payout_publication_status
       ) THEN
        NEW.lease_owner := NULL;
        NEW.lease_token := NULL;
        NEW.lease_expires_at := NULL;
        -- retain sending_started_at + identity_frozen_at + identity + delivery snapshots
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_payout_publications_enforce_update() IS
    'Phase 17 Step 2: identity + delivery snapshot freeze; DB-owned SENDING clocks; FAILED clears snapshots.';

INSERT INTO schema_migrations (version)
VALUES ('0058_phase17_publication_delivery_snapshot')
ON CONFLICT (version) DO NOTHING;

COMMIT;
