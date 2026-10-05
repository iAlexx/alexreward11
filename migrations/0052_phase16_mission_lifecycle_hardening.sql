-- ALEx Rewards — Phase 16 Step 1.1
-- 0052_phase16_mission_lifecycle_hardening.sql
--
-- Narrow hardening only:
--   * mission_progress.started_at / completed_at provenance one-shot rules
--   * mission_progress_events FOR SHARE + [start_at, end_at) window on INSERT
--   * safe end_at closure includes MAX(mission_progress_events.occurred_at)
--   * mission_claim_events actor_type / actor_id audit provenance
-- Additive. NO production seeds. NO monetary mission issuance.
-- Does NOT amend 0051.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. started_at one-shot + completion preserves start; same-state timestamp freeze
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_mission_progress_enforce_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.progress_count < OLD.progress_count THEN
        RAISE EXCEPTION
            'mission_progress.progress_count must be monotonic non-decreasing'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.state = 'CLAIMED' OR OLD.state = 'CLAIMED' THEN
        RAISE EXCEPTION
            'mission_progress must not use CLAIMED state'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Once started_at is non-null it is permanently immutable.
    IF OLD.started_at IS NOT NULL
        AND OLD.started_at IS DISTINCT FROM NEW.started_at
    THEN
        RAISE EXCEPTION
            'mission_progress.started_at is immutable once set'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- NULL → timestamp only on first start: NOT_STARTED → IN_PROGRESS|COMPLETED.
    IF OLD.started_at IS NULL AND NEW.started_at IS NOT NULL THEN
        IF NOT (
            OLD.state = 'NOT_STARTED'
            AND NEW.state IN ('IN_PROGRESS', 'COMPLETED')
        ) THEN
            RAISE EXCEPTION
                'mission_progress.started_at may be set only on NOT_STARTED→IN_PROGRESS|COMPLETED'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Once completed_at is non-null it is permanently immutable (covers COMPLETED rewrite).
    IF OLD.completed_at IS NOT NULL
        AND OLD.completed_at IS DISTINCT FROM NEW.completed_at
    THEN
        RAISE EXCEPTION
            'mission_progress.completed_at is immutable once set'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Terminal freeze: COMPLETED / EXPIRED cannot change state or progress fields.
    IF OLD.state IN ('COMPLETED', 'EXPIRED') THEN
        IF OLD.state IS DISTINCT FROM NEW.state
            OR OLD.progress_count IS DISTINCT FROM NEW.progress_count
            OR OLD.started_at IS DISTINCT FROM NEW.started_at
            OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        THEN
            RAISE EXCEPTION
                'mission progress terminal state % is immutable',
                OLD.state
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- Same-state IN_PROGRESS: progress_count may rise; timestamps must not change.
    IF OLD.state = 'IN_PROGRESS' AND NEW.state = 'IN_PROGRESS' THEN
        IF OLD.started_at IS DISTINCT FROM NEW.started_at
            OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
        THEN
            RAISE EXCEPTION
                'mission_progress IN_PROGRESS timestamps are immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    -- IN_PROGRESS → COMPLETED must preserve started_at (already enforced above);
    -- completed_at may transition NULL → timestamp via field consistency CHECK.
    IF OLD.state = 'IN_PROGRESS' AND NEW.state = 'COMPLETED' THEN
        IF OLD.started_at IS DISTINCT FROM NEW.started_at THEN
            RAISE EXCEPTION
                'mission_progress.started_at must be preserved on completion'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'NOT_STARTED' AND NEW.state IN ('IN_PROGRESS', 'COMPLETED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'IN_PROGRESS' AND NEW.state = 'EXPIRED' THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'invalid mission progress state transition from % to %',
        OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION app_mission_progress_enforce_state_machine() IS
    'Phase 16 Step 1.1: monotonic progress_count; started_at one-shot; completed_at '
    'immutable once set; IN_PROGRESS timestamp freeze; NOT_STARTED→IN_PROGRESS|COMPLETED|'
    'EXPIRED; IN_PROGRESS→COMPLETED|EXPIRED; reject CLAIMED; terminal freeze.';

-- ---------------------------------------------------------------------------
-- B. Contribution events: FOR SHARE version lock + [start_at, end_at) window
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_mission_progress_events_lock_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_start_at timestamptz;
    v_end_at   timestamptz;
BEGIN
    SELECT mv.start_at, mv.end_at
    INTO v_start_at, v_end_at
    FROM mission_versions mv
    WHERE mv.id = NEW.mission_version_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'mission version % not found for progress event lock',
            NEW.mission_version_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Window is half-open [start_at, end_at). Status need not be ACTIVE (redrive).
    IF v_start_at IS NOT NULL AND NEW.occurred_at < v_start_at THEN
        RAISE EXCEPTION
            'mission_progress_events.occurred_at must be >= mission_versions.start_at'
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_end_at IS NOT NULL AND NEW.occurred_at >= v_end_at THEN
        RAISE EXCEPTION
            'mission_progress_events.occurred_at must be < mission_versions.end_at'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_progress_events_lock_version() IS
    'Phase 16 Step 1.1: BEFORE INSERT locks mission_versions FOR SHARE and enforces '
    'occurred_at ∈ [start_at, end_at). Does not require CURRENT status = ACTIVE.';

DROP TRIGGER IF EXISTS mission_progress_events_lock_version ON mission_progress_events;

CREATE TRIGGER mission_progress_events_lock_version
    BEFORE INSERT ON mission_progress_events
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_progress_events_lock_version();

-- ---------------------------------------------------------------------------
-- C. Safe end_at closure includes contribution occurred_at (not created_at)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_mission_versions_reject_semantic_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_max_ref timestamptz;
BEGIN
    IF OLD.mission_definition_id IS DISTINCT FROM NEW.mission_definition_id
        OR OLD.mission_version IS DISTINCT FROM NEW.mission_version
        OR OLD.name_key IS DISTINCT FROM NEW.name_key
        OR OLD.description_key IS DISTINCT FROM NEW.description_key
        OR OLD.condition_type IS DISTINCT FROM NEW.condition_type
        OR OLD.target IS DISTINCT FROM NEW.target
        OR OLD.reset_policy IS DISTINCT FROM NEW.reset_policy
        OR OLD.eligibility_policy IS DISTINCT FROM NEW.eligibility_policy
        OR OLD.required_membership_plan_id IS DISTINCT FROM NEW.required_membership_plan_id
        OR OLD.reward_source_type IS DISTINCT FROM NEW.reward_source_type
        OR OLD.reward_rule_id IS DISTINCT FROM NEW.reward_rule_id
        OR OLD.start_at IS DISTINCT FROM NEW.start_at
        OR OLD.created_by_admin_id IS DISTINCT FROM NEW.created_by_admin_id
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'mission version semantics are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- status / updated_at remain mutable for lifecycle.
    IF OLD.end_at IS NOT DISTINCT FROM NEW.end_at THEN
        RETURN NEW;
    END IF;

    -- Reject non-null rewrites and reopen (non-null → NULL).
    IF OLD.end_at IS NOT NULL THEN
        RAISE EXCEPTION
            'mission version end_at cannot be rewritten'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.end_at IS NULL THEN
        RAISE EXCEPTION
            'mission version end_at cannot reopen to NULL'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.start_at IS NOT NULL AND NEW.end_at <= NEW.start_at THEN
        RAISE EXCEPTION
            'mission version end_at must be after start_at'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT GREATEST(
        (SELECT MAX(p.created_at)
         FROM mission_progress p
         WHERE p.mission_version_id = OLD.id),
        (SELECT MAX(p.started_at)
         FROM mission_progress p
         WHERE p.mission_version_id = OLD.id),
        (SELECT MAX(p.completed_at)
         FROM mission_progress p
         WHERE p.mission_version_id = OLD.id),
        (SELECT MAX(c.claimed_at)
         FROM mission_claims c
         WHERE c.mission_version_id = OLD.id),
        (SELECT MAX(c.granted_at)
         FROM mission_claims c
         WHERE c.mission_version_id = OLD.id),
        -- Contribution occurrence (not event created_at — redrive may be later).
        (SELECT MAX(e.occurred_at)
         FROM mission_progress_events e
         WHERE e.mission_version_id = OLD.id)
    )
    INTO v_max_ref;

    -- Unreferenced: allow first NULL → non-null closure (window CHECK already applied).
    IF v_max_ref IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.end_at <= v_max_ref THEN
        RAISE EXCEPTION
            'mission version end_at must be after latest progress/claim/contribution reference'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_versions_reject_semantic_update() IS
    'Phase 16 Step 1.1: freeze mission version economics/identity. Status remains mutable. '
    'end_at may close once (NULL→non-null) with NEW.end_at > GREATEST of progress/claim/'
    'contribution(occurred_at) references; non-null rewrite and reopen are rejected.';

-- ---------------------------------------------------------------------------
-- D. mission_claim_events actor provenance
-- ---------------------------------------------------------------------------
-- Preflight note: any existing mission_claim_events rows were produced solely by the
-- Phase 16 Step 1 DB trigger (SYSTEM foundation) before any public claim engine.
-- Adding actor_type NOT NULL DEFAULT 'SYSTEM' + actor_id NULL backfills that
-- foundation default only. Do not rewrite status/reward/reason/timestamps.

ALTER TABLE mission_claim_events
    ADD COLUMN IF NOT EXISTS actor_type actor_type NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE mission_claim_events
    ADD COLUMN IF NOT EXISTS actor_id UUID NULL;

COMMENT ON COLUMN mission_claim_events.actor_type IS
    'Audit actor class. DB-trigger foundation events use SYSTEM; no polymorphic FK.';

COMMENT ON COLUMN mission_claim_events.actor_id IS
    'Optional actor id. Foundation trigger events leave NULL. No polymorphic FK.';

CREATE OR REPLACE FUNCTION app_mission_claims_record_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO mission_claim_events (
            mission_claim_id, from_status, to_status, reward_event_id, rejection_reason,
            actor_type, actor_id
        ) VALUES (
            NEW.id, NULL, NEW.status, NEW.reward_event_id, NEW.rejection_reason,
            'SYSTEM'::actor_type, NULL
        );
        RETURN NEW;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO mission_claim_events (
            mission_claim_id, from_status, to_status, reward_event_id, rejection_reason,
            actor_type, actor_id
        ) VALUES (
            NEW.id, OLD.status, NEW.status, NEW.reward_event_id, NEW.rejection_reason,
            'SYSTEM'::actor_type, NULL
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_claims_record_event() IS
    'Phase 16 Step 1.1: append mission_claim_events on INSERT and status change with '
    'actor_type=SYSTEM, actor_id=NULL foundation provenance.';

COMMENT ON TABLE mission_claim_events IS
    'Phase 16 append-only claim lifecycle events (insert + status transitions) with '
    'actor_type/actor_id audit provenance. Foundation trigger uses SYSTEM/NULL.';

COMMIT;
