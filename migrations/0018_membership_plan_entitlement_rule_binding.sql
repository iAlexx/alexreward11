-- ALEx Rewards — Phase 7.1 entitlement mapping integrity
-- 0018_membership_plan_entitlement_rule_binding.sql
--
-- Proven need: membership_plan_entitlements.rule_version_id must reference a
-- membership_benefit_rule_versions row whose entitlement_id matches the mapping
-- and whose membership_plan_id is NULL (global) or equals the mapped plan.
-- Prevents cross-bound fee/priority (or any) entitlement rule misuse.
-- Do NOT edit 0008 / 0013 / 0017.

BEGIN;

CREATE OR REPLACE FUNCTION app_membership_plan_entitlements_rule_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    rule_entitlement_id UUID;
    rule_plan_id UUID;
BEGIN
    SELECT entitlement_id, membership_plan_id
      INTO rule_entitlement_id, rule_plan_id
      FROM membership_benefit_rule_versions
     WHERE id = NEW.rule_version_id;

    IF rule_entitlement_id IS NULL THEN
        RAISE EXCEPTION 'membership_plan_entitlements.rule_version_id not found'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF rule_entitlement_id IS DISTINCT FROM NEW.entitlement_id THEN
        RAISE EXCEPTION
            'membership_plan_entitlements entitlement_id must match benefit rule entitlement_id'
            USING ERRCODE = 'check_violation';
    END IF;

    IF rule_plan_id IS NOT NULL AND rule_plan_id IS DISTINCT FROM NEW.membership_plan_id THEN
        RAISE EXCEPTION
            'membership_plan_entitlements cannot bind a rule belonging to another membership plan'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS membership_plan_entitlements_rule_binding
    ON membership_plan_entitlements;
CREATE TRIGGER membership_plan_entitlements_rule_binding
    BEFORE INSERT OR UPDATE OF membership_plan_id, entitlement_id, rule_version_id
    ON membership_plan_entitlements
    FOR EACH ROW EXECUTE FUNCTION app_membership_plan_entitlements_rule_binding();

COMMENT ON FUNCTION app_membership_plan_entitlements_rule_binding() IS
    'Phase 7.1: fail-closed binding so plan entitlement mappings cannot point at '
    'a benefit rule for a different entitlement or another plan.';

INSERT INTO schema_migrations (version)
VALUES ('0018_membership_plan_entitlement_rule_binding')
ON CONFLICT (version) DO NOTHING;

COMMIT;
