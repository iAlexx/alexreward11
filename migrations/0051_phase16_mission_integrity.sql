-- ALEx Rewards — Phase 16 Step 1
-- 0051_phase16_mission_integrity.sql
--
-- Scope: mission_* authority comments, definition/version semantic freeze,
-- ACTIVE window GiST exclusion, safe end_at closure, first-reference FOR SHARE,
-- reward_rules composite FK, mission_progress / claims integrity + append-only
-- progress/claim events, task_reward_events append-only.
-- Additive only. NO production seeds. NO monetary mission issuance.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Authority comments: mission_* is Phase 16; task_* is legacy/compat only
-- ---------------------------------------------------------------------------

COMMENT ON TABLE mission_definitions IS
    'Phase 16 authoritative stable mission identity. task_definitions is legacy/'
    'compatibility only — not a second monetary path.';

COMMENT ON TABLE mission_versions IS
    'Phase 16 authoritative versioned mission rules. task_definition_versions is '
    'legacy/compatibility only — monetary rewards always route Mission → Reward '
    'Engine → Ledger; never a parallel task monetary path.';

COMMENT ON TABLE mission_progress IS
    'Phase 16 authoritative server-verified mission progress. user_task_progress '
    'is legacy/compatibility only — not a second monetary path.';

COMMENT ON TABLE mission_claims IS
    'Phase 16 authoritative one-claim-per-version/user/period. Monetary grants '
    'route through the reward engine and immutable ledger. task_reward_events is '
    'legacy/compatibility only — not a second monetary path.';

COMMENT ON TABLE task_definitions IS
    'Legacy/compatibility task identity. Phase 16 monetary authority is mission_*.';

COMMENT ON TABLE task_definition_versions IS
    'Legacy/compatibility task versions. Phase 16 monetary authority is mission_*.';

COMMENT ON TABLE user_task_progress IS
    'Legacy/compatibility task progress. Phase 16 monetary authority is mission_*.';

COMMENT ON TABLE task_reward_events IS
    'Legacy/compatibility bridge rows. Append-only. Phase 16 monetary authority is '
    'mission_claims → reward engine — not a second monetary path.';

-- ---------------------------------------------------------------------------
-- B. mission_definitions identity freeze + delete guard; FK CASCADE → RESTRICT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_mission_definitions_reject_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id
        OR OLD.code IS DISTINCT FROM NEW.code
        OR OLD.name_key IS DISTINCT FROM NEW.name_key
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'mission definition identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_definitions_reject_identity_update() IS
    'Phase 16 Step 1: freeze id/code/name_key/created_at; status/updated_at remain mutable.';

DROP TRIGGER IF EXISTS mission_definitions_reject_identity_update ON mission_definitions;

CREATE TRIGGER mission_definitions_reject_identity_update
    BEFORE UPDATE ON mission_definitions
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_definitions_reject_identity_update();

CREATE OR REPLACE FUNCTION app_mission_definitions_reject_delete_if_versions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM mission_versions v
        WHERE v.mission_definition_id = OLD.id
    ) THEN
        RAISE EXCEPTION
            'mission definition cannot be deleted while mission_versions exist'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION app_mission_definitions_reject_delete_if_versions() IS
    'Phase 16 Step 1: block DELETE on mission_definitions when any version rows exist.';

DROP TRIGGER IF EXISTS mission_definitions_reject_delete_if_versions ON mission_definitions;

CREATE TRIGGER mission_definitions_reject_delete_if_versions
    BEFORE DELETE ON mission_definitions
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_definitions_reject_delete_if_versions();

ALTER TABLE mission_versions
    DROP CONSTRAINT IF EXISTS mission_versions_mission_definition_id_fkey;

ALTER TABLE mission_versions
    ADD CONSTRAINT mission_versions_mission_definition_id_fkey
        FOREIGN KEY (mission_definition_id)
        REFERENCES mission_definitions (id)
        ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- C/D/E. mission_versions semantic freeze + ACTIVE GiST exclusion + safe end_at
-- ---------------------------------------------------------------------------

ALTER TABLE mission_versions
    DROP CONSTRAINT IF EXISTS mission_versions_no_active_overlap;

ALTER TABLE mission_versions
    ADD CONSTRAINT mission_versions_no_active_overlap
        EXCLUDE USING gist (
            mission_definition_id WITH =,
            tstzrange(start_at, end_at, '[)') WITH &&
        ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT mission_versions_no_active_overlap ON mission_versions IS
    'At most one ACTIVE mission_versions window per mission_definition_id may apply '
    'at any instant. DRAFT / SUPERSEDED / REVOKED rows are unrestricted by this guard.';

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
         WHERE c.mission_version_id = OLD.id)
    )
    INTO v_max_ref;

    -- Unreferenced: allow first NULL → non-null closure (window CHECK already applied).
    IF v_max_ref IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.end_at <= v_max_ref THEN
        RAISE EXCEPTION
            'mission version end_at must be after latest progress/claim reference'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_versions_reject_semantic_update() IS
    'Phase 16 Step 1: freeze mission version economics/identity. Status remains mutable. '
    'end_at may close once (NULL→non-null) with NEW.end_at > GREATEST of progress/'
    'claim reference timestamps; non-null rewrite and reopen are rejected.';

DROP TRIGGER IF EXISTS mission_versions_reject_semantic_update ON mission_versions;

CREATE TRIGGER mission_versions_reject_semantic_update
    BEFORE UPDATE ON mission_versions
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_versions_reject_semantic_update();

-- ---------------------------------------------------------------------------
-- F. First-reference FOR SHARE on progress/claims INSERT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_mission_progress_lock_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_target integer;
BEGIN
    SELECT mv.target
    INTO v_target
    FROM mission_versions mv
    WHERE mv.id = NEW.mission_version_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'mission version % not found for lock',
            NEW.mission_version_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.target IS DISTINCT FROM v_target THEN
        RAISE EXCEPTION
            'mission_progress.target must equal mission_versions.target'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_progress_lock_version() IS
    'Phase 16 Step 1: BEFORE INSERT locks mission_versions FOR SHARE and requires '
    'NEW.target = version.target.';

DROP TRIGGER IF EXISTS mission_progress_lock_version ON mission_progress;

CREATE TRIGGER mission_progress_lock_version
    BEFORE INSERT ON mission_progress
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_progress_lock_version();

CREATE OR REPLACE FUNCTION app_mission_claims_lock_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1
    FROM mission_versions mv
    WHERE mv.id = NEW.mission_version_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'mission version % not found for lock',
            NEW.mission_version_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_claims_lock_version() IS
    'Phase 16 Step 1: BEFORE INSERT on mission_claims acquires FOR SHARE on the '
    'referenced mission_versions row.';

DROP TRIGGER IF EXISTS mission_claims_lock_version ON mission_claims;

CREATE TRIGGER mission_claims_lock_version
    BEFORE INSERT ON mission_claims
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_claims_lock_version();

-- ---------------------------------------------------------------------------
-- G. reward_rules UNIQUE (id, source_type) + composite FK from mission_versions
-- ---------------------------------------------------------------------------

ALTER TABLE reward_rules
    DROP CONSTRAINT IF EXISTS reward_rules_id_source_type_key;

ALTER TABLE reward_rules
    ADD CONSTRAINT reward_rules_id_source_type_key
        UNIQUE (id, source_type);

COMMENT ON CONSTRAINT reward_rules_id_source_type_key ON reward_rules IS
    'Composite target for mission_versions (reward_rule_id, reward_source_type) FK.';

ALTER TABLE mission_versions
    DROP CONSTRAINT IF EXISTS mission_versions_reward_rule_id_fkey;

ALTER TABLE mission_versions
    DROP CONSTRAINT IF EXISTS mission_versions_reward_rule_composite_fkey;

ALTER TABLE mission_versions
    ADD CONSTRAINT mission_versions_reward_rule_composite_fkey
        FOREIGN KEY (reward_rule_id, reward_source_type)
        REFERENCES reward_rules (id, source_type)
        ON DELETE RESTRICT;

COMMENT ON CONSTRAINT mission_versions_reward_rule_composite_fkey ON mission_versions IS
    'Pins reward_rule_id to a reward_rules row whose source_type matches '
    'reward_source_type. NULL reward_rule_id skips the composite FK check.';

-- ---------------------------------------------------------------------------
-- H. mission_progress: identity freeze, bounds, monotonicity, state machine
-- ---------------------------------------------------------------------------

ALTER TABLE mission_progress
    DROP CONSTRAINT IF EXISTS mission_progress_progress_count_check;

ALTER TABLE mission_progress
    DROP CONSTRAINT IF EXISTS mission_progress_progress_bounds;

ALTER TABLE mission_progress
    ADD CONSTRAINT mission_progress_progress_bounds
        CHECK (progress_count >= 0 AND progress_count <= target);

COMMENT ON CONSTRAINT mission_progress_progress_bounds ON mission_progress IS
    'progress_count must stay within [0, target].';

ALTER TABLE mission_progress
    DROP CONSTRAINT IF EXISTS mission_progress_no_claimed_state;

ALTER TABLE mission_progress
    ADD CONSTRAINT mission_progress_no_claimed_state
        CHECK (state <> 'CLAIMED');

COMMENT ON CONSTRAINT mission_progress_no_claimed_state ON mission_progress IS
    'CLAIMED is rejected on mission_progress; claims live in mission_claims.';

ALTER TABLE mission_progress
    DROP CONSTRAINT IF EXISTS mission_progress_state_fields_consistent;

ALTER TABLE mission_progress
    ADD CONSTRAINT mission_progress_state_fields_consistent
        CHECK (
            (
                state = 'NOT_STARTED'
                AND progress_count = 0
                AND started_at IS NULL
                AND completed_at IS NULL
            )
            OR (
                state = 'IN_PROGRESS'
                AND progress_count > 0
                AND progress_count < target
                AND started_at IS NOT NULL
                AND completed_at IS NULL
            )
            OR (
                state = 'COMPLETED'
                AND progress_count = target
                AND started_at IS NOT NULL
                AND completed_at IS NOT NULL
            )
            OR (
                state = 'EXPIRED'
                AND completed_at IS NULL
                AND progress_count >= 0
                AND progress_count <= target
            )
        );

COMMENT ON CONSTRAINT mission_progress_state_fields_consistent ON mission_progress IS
    'NOT_STARTED/IN_PROGRESS/COMPLETED/EXPIRED field consistency for mission progress.';

-- Composite identity key for child FKs (progress events + claims).
ALTER TABLE mission_progress
    DROP CONSTRAINT IF EXISTS mission_progress_identity_key;

ALTER TABLE mission_progress
    ADD CONSTRAINT mission_progress_identity_key
        UNIQUE (id, mission_version_id, user_id, period_key);

CREATE OR REPLACE FUNCTION app_mission_progress_reject_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.mission_version_id IS DISTINCT FROM NEW.mission_version_id
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.period_key IS DISTINCT FROM NEW.period_key
        OR OLD.target IS DISTINCT FROM NEW.target
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'mission progress identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_progress_reject_identity_update() IS
    'Phase 16 Step 1: freeze mission_version_id/user_id/period_key/target/created_at.';

DROP TRIGGER IF EXISTS mission_progress_reject_identity_update ON mission_progress;

CREATE TRIGGER mission_progress_reject_identity_update
    BEFORE UPDATE ON mission_progress
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_progress_reject_identity_update();

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

    IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'NOT_STARTED' AND NEW.state IN ('IN_PROGRESS', 'COMPLETED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;

    IF OLD.state = 'IN_PROGRESS' AND NEW.state IN ('COMPLETED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'invalid mission progress state transition from % to %',
        OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION app_mission_progress_enforce_state_machine() IS
    'Phase 16 Step 1: monotonic progress_count; NOT_STARTED→IN_PROGRESS|COMPLETED|EXPIRED; '
    'IN_PROGRESS→COMPLETED|EXPIRED; reject CLAIMED; terminal freeze.';

DROP TRIGGER IF EXISTS mission_progress_enforce_state_machine ON mission_progress;

CREATE TRIGGER mission_progress_enforce_state_machine
    BEFORE UPDATE ON mission_progress
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_progress_enforce_state_machine();

-- ---------------------------------------------------------------------------
-- I. mission_progress_events append-only + composite consistency
-- ---------------------------------------------------------------------------

CREATE TABLE mission_progress_events (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_progress_id UUID NOT NULL,
    mission_version_id  UUID NOT NULL,
    user_id             UUID NOT NULL,
    period_key          TEXT NOT NULL,
    source_kind         TEXT NOT NULL,
    source_key          TEXT NOT NULL,
    progress_delta      INTEGER NOT NULL CHECK (progress_delta > 0),
    occurred_at         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mission_progress_events_source_key
        UNIQUE (mission_progress_id, source_kind, source_key),
    CONSTRAINT mission_progress_events_source_kind_check
        CHECK (source_kind IN (
            'AUTHENTICATED_LOGIN_DAY',
            'REWARD_EVENT',
            'STREAK_DAY',
            'REFERRAL_EDGE'
        )),
    CONSTRAINT mission_progress_events_parent_fkey
        FOREIGN KEY (mission_progress_id, mission_version_id, user_id, period_key)
        REFERENCES mission_progress (id, mission_version_id, user_id, period_key)
        ON DELETE RESTRICT
);

COMMENT ON TABLE mission_progress_events IS
    'Phase 16 append-only idempotent progress source ledger. One row per '
    '(mission_progress_id, source_kind, source_key).';

CREATE INDEX mission_progress_events_progress_idx
    ON mission_progress_events (mission_progress_id, created_at);

CREATE TRIGGER mission_progress_events_reject_update
    BEFORE UPDATE ON mission_progress_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER mission_progress_events_reject_delete
    BEFORE DELETE ON mission_progress_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- J. mission_claims: NOT NULL progress, composite match, state machine, events
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_null_progress bigint;
BEGIN
    SELECT count(*) INTO v_null_progress
    FROM mission_claims
    WHERE mission_progress_id IS NULL;

    IF v_null_progress > 0 THEN
        RAISE EXCEPTION
            'Phase 16 Step 1 preflight STOP: % mission_claims row(s) have NULL mission_progress_id — refuse silent rewrite',
            v_null_progress;
    END IF;
END;
$$;

ALTER TABLE mission_claims
    ALTER COLUMN mission_progress_id SET NOT NULL;

ALTER TABLE mission_claims
    DROP CONSTRAINT IF EXISTS mission_claims_mission_progress_id_fkey;

ALTER TABLE mission_claims
    DROP CONSTRAINT IF EXISTS mission_claims_progress_identity_fkey;

ALTER TABLE mission_claims
    ADD CONSTRAINT mission_claims_progress_identity_fkey
        FOREIGN KEY (mission_progress_id, mission_version_id, user_id, period_key)
        REFERENCES mission_progress (id, mission_version_id, user_id, period_key)
        ON DELETE RESTRICT;

COMMENT ON CONSTRAINT mission_claims_progress_identity_fkey ON mission_claims IS
    'Claim must reference progress with matching mission_version_id/user_id/period_key.';

ALTER TABLE mission_claims
    DROP CONSTRAINT IF EXISTS mission_claims_state_fields_consistent;

ALTER TABLE mission_claims
    ADD CONSTRAINT mission_claims_state_fields_consistent
        CHECK (
            (
                status = 'PENDING'
                AND reward_event_id IS NULL
                AND granted_at IS NULL
                AND rejection_reason IS NULL
            )
            OR (
                status = 'GRANTED'
                AND granted_at IS NOT NULL
                AND rejection_reason IS NULL
            )
            OR (
                status = 'REJECTED'
                AND reward_event_id IS NULL
                AND granted_at IS NULL
                AND rejection_reason IS NOT NULL
                AND btrim(rejection_reason) <> ''
            )
        );

COMMENT ON CONSTRAINT mission_claims_state_fields_consistent ON mission_claims IS
    'PENDING/GRANTED/REJECTED field consistency for mission claim lifecycle.';

CREATE OR REPLACE FUNCTION app_mission_claims_reject_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.mission_version_id IS DISTINCT FROM NEW.mission_version_id
        OR OLD.mission_progress_id IS DISTINCT FROM NEW.mission_progress_id
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.period_key IS DISTINCT FROM NEW.period_key
        OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
        OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
        RAISE EXCEPTION
            'mission claim identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_claims_reject_identity_update() IS
    'Phase 16 Step 1: freeze claim identity fields; status/reward/rejection may change.';

DROP TRIGGER IF EXISTS mission_claims_reject_identity_update ON mission_claims;

CREATE TRIGGER mission_claims_reject_identity_update
    BEFORE UPDATE ON mission_claims
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_claims_reject_identity_update();

CREATE OR REPLACE FUNCTION app_mission_claims_enforce_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('GRANTED', 'REJECTED') THEN
        IF OLD.status IS DISTINCT FROM NEW.status
            OR OLD.reward_event_id IS DISTINCT FROM NEW.reward_event_id
            OR OLD.granted_at IS DISTINCT FROM NEW.granted_at
            OR OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason
        THEN
            RAISE EXCEPTION
                'mission claim terminal status % is immutable',
                OLD.status
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'PENDING' AND NEW.status IN ('GRANTED', 'REJECTED') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'invalid mission claim status transition from % to %',
        OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION app_mission_claims_enforce_state_machine() IS
    'Phase 16 Step 1: only PENDING→GRANTED|REJECTED; terminal freeze.';

DROP TRIGGER IF EXISTS mission_claims_enforce_state_machine ON mission_claims;

CREATE TRIGGER mission_claims_enforce_state_machine
    BEFORE UPDATE ON mission_claims
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_claims_enforce_state_machine();

CREATE TABLE mission_claim_events (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    mission_claim_id    UUID NOT NULL REFERENCES mission_claims (id) ON DELETE RESTRICT,
    from_status         mission_claim_status NULL,
    to_status           mission_claim_status NOT NULL,
    reward_event_id     UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    rejection_reason    TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mission_claim_events IS
    'Phase 16 append-only claim lifecycle events (insert + status transitions).';

CREATE INDEX mission_claim_events_claim_idx
    ON mission_claim_events (mission_claim_id, created_at);

CREATE TRIGGER mission_claim_events_reject_update
    BEFORE UPDATE ON mission_claim_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER mission_claim_events_reject_delete
    BEFORE DELETE ON mission_claim_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE OR REPLACE FUNCTION app_mission_claims_record_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO mission_claim_events (
            mission_claim_id, from_status, to_status, reward_event_id, rejection_reason
        ) VALUES (
            NEW.id, NULL, NEW.status, NEW.reward_event_id, NEW.rejection_reason
        );
        RETURN NEW;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO mission_claim_events (
            mission_claim_id, from_status, to_status, reward_event_id, rejection_reason
        ) VALUES (
            NEW.id, OLD.status, NEW.status, NEW.reward_event_id, NEW.rejection_reason
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app_mission_claims_record_event() IS
    'Phase 16 Step 1: append mission_claim_events on INSERT and status change.';

DROP TRIGGER IF EXISTS mission_claims_record_event ON mission_claims;

CREATE TRIGGER mission_claims_record_event
    AFTER INSERT OR UPDATE ON mission_claims
    FOR EACH ROW
    EXECUTE FUNCTION app_mission_claims_record_event();

-- ---------------------------------------------------------------------------
-- K. task_reward_events append-only (legacy path must not mutate)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS task_reward_events_reject_update ON task_reward_events;
DROP TRIGGER IF EXISTS task_reward_events_reject_delete ON task_reward_events;

CREATE TRIGGER task_reward_events_reject_update
    BEFORE UPDATE ON task_reward_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER task_reward_events_reject_delete
    BEFORE DELETE ON task_reward_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

INSERT INTO schema_migrations (version)
VALUES ('0051_phase16_mission_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
