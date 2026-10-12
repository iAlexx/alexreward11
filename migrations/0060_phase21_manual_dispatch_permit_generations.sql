-- ALEx Rewards Phase 21
-- 0060_phase21_manual_dispatch_permit_generations.sql
-- Smallest safe change: allow a second one-shot authorization generation per withdrawal
-- while permanently preserving Gen-1 CONSUMED rows and attempt bindings.
-- Additive. No seeds. No money movement.

BEGIN;

ALTER TABLE phase21_manual_dispatch_permits
  ADD COLUMN IF NOT EXISTS authorization_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE phase21_manual_dispatch_permits
  DROP CONSTRAINT IF EXISTS phase21_manual_dispatch_permits_withdrawal_unique;

ALTER TABLE phase21_manual_dispatch_permits
  DROP CONSTRAINT IF EXISTS phase21_manual_dispatch_permits_withdrawal_generation_unique;

ALTER TABLE phase21_manual_dispatch_permits
  ADD CONSTRAINT phase21_manual_dispatch_permits_withdrawal_generation_unique
  UNIQUE (withdrawal_id, authorization_generation);

ALTER TABLE phase21_manual_dispatch_permits
  DROP CONSTRAINT IF EXISTS phase21_manual_dispatch_permits_generation_positive_chk;

ALTER TABLE phase21_manual_dispatch_permits
  ADD CONSTRAINT phase21_manual_dispatch_permits_generation_positive_chk
  CHECK (authorization_generation >= 1);

-- At most one live ARMED permit per withdrawal across all generations.
DROP INDEX IF EXISTS phase21_manual_dispatch_permits_one_armed_per_withdrawal_uidx;
CREATE UNIQUE INDEX phase21_manual_dispatch_permits_one_armed_per_withdrawal_uidx
  ON phase21_manual_dispatch_permits (withdrawal_id)
  WHERE status = 'ARMED'::phase21_manual_dispatch_permit_status;

COMMENT ON COLUMN phase21_manual_dispatch_permits.authorization_generation IS
  'Owner authorization generation. Gen-1 CONSUMED rows are immutable history. Gen>=2 is a fresh one-shot arm for recovery after FAILED_PRE without durable BOC; never resets or reuses a prior CONSUMED generation.';

INSERT INTO schema_migrations (version)
VALUES ('0060_phase21_manual_dispatch_permit_generations')
ON CONFLICT (version) DO NOTHING;

COMMIT;
