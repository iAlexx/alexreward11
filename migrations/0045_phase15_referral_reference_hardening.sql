-- ALEx Rewards — Phase 15 Step 1.1
-- 0045_phase15_referral_reference_hardening.sql
--
-- Scope: freeze terminal referral_edges activation/rejection provenance;
-- fail closed on orphan referral-rule FK references; VALIDATE both FKs.
-- Does not edit 0044. No seeds. No referral money / writers / rates.

BEGIN;

-- ---------------------------------------------------------------------------
-- Terminal edge provenance immutability (ACTIVE / REJECTED)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_referral_edge_enforce_state_machine()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state = 'ACTIVE' THEN
        IF NEW.state IS DISTINCT FROM OLD.state
            OR NEW.activation_rule_version IS DISTINCT FROM OLD.activation_rule_version
            OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
            OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
            OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
        THEN
            RAISE EXCEPTION
                'ACTIVE referral edge activation provenance is immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'REJECTED' THEN
        IF NEW.state IS DISTINCT FROM OLD.state
            OR NEW.activation_rule_version IS DISTINCT FROM OLD.activation_rule_version
            OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
            OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
            OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
        THEN
            RAISE EXCEPTION
                'REJECTED referral edge rejection provenance is immutable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'PENDING' THEN
        IF NEW.state IS NOT DISTINCT FROM 'PENDING' THEN
            IF NEW.activation_rule_version IS DISTINCT FROM OLD.activation_rule_version
                OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
                OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
                OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
            THEN
                RAISE EXCEPTION
                    'PENDING referral edge cannot carry activation/rejection evidence'
                    USING ERRCODE = 'restrict_violation';
            END IF;
            RETURN NEW;
        END IF;

        IF NEW.state IN ('ACTIVE', 'REJECTED') THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'invalid referral edge state transition from % to %',
            OLD.state, NEW.state
            USING ERRCODE = 'check_violation';
    END IF;

    RAISE EXCEPTION
        'invalid referral edge state transition from % to %',
        OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION app_referral_edge_enforce_state_machine() IS
    'Phase 15 Step 1.1: PENDING→ACTIVE/REJECTED only; terminal ACTIVE/REJECTED '
    'activation/rejection provenance is immutable (restrict_violation).';

-- Trigger already exists from 0044; function replacement is sufficient.

-- ---------------------------------------------------------------------------
-- Orphan referral-rule references must fail the migration (no NOT VALID fallback)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    orphan_edges bigint;
    orphan_events bigint;
BEGIN
    SELECT count(*) INTO orphan_edges
    FROM referral_edges e
    WHERE e.activation_rule_version IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM referral_rule_versions v
          WHERE v.rule_version = e.activation_rule_version
      );

    IF orphan_edges > 0 THEN
        RAISE EXCEPTION
            'referral_edges has % orphan activation_rule_version reference(s); refuse migration',
            orphan_edges
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT count(*) INTO orphan_events
    FROM referral_reward_events r
    WHERE NOT EXISTS (
        SELECT 1
        FROM referral_rule_versions v
        WHERE v.rule_version = r.rule_version
    );

    IF orphan_events > 0 THEN
        RAISE EXCEPTION
            'referral_reward_events has % orphan rule_version reference(s); refuse migration',
            orphan_events
            USING ERRCODE = 'foreign_key_violation';
    END IF;
END;
$$;

-- Ensure FKs exist (idempotent if 0044 already created them) then VALIDATE.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'referral_edges_activation_rule_version_fkey'
    ) THEN
        ALTER TABLE referral_edges
            ADD CONSTRAINT referral_edges_activation_rule_version_fkey
                FOREIGN KEY (activation_rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'referral_reward_events_rule_version_fkey'
    ) THEN
        ALTER TABLE referral_reward_events
            ADD CONSTRAINT referral_reward_events_rule_version_fkey
                FOREIGN KEY (rule_version)
                REFERENCES referral_rule_versions (rule_version)
                ON DELETE RESTRICT;
    END IF;
END;
$$;

ALTER TABLE referral_edges
    VALIDATE CONSTRAINT referral_edges_activation_rule_version_fkey;

ALTER TABLE referral_reward_events
    VALIDATE CONSTRAINT referral_reward_events_rule_version_fkey;

COMMENT ON CONSTRAINT referral_edges_activation_rule_version_fkey ON referral_edges IS
    'Validated FK: referral_edges.activation_rule_version → referral_rule_versions.rule_version.';

COMMENT ON CONSTRAINT referral_reward_events_rule_version_fkey ON referral_reward_events IS
    'Validated FK: referral_reward_events.rule_version → referral_rule_versions.rule_version.';

COMMIT;
