-- ALEx Rewards — Phase 5 narrow correction: budget scope / UTC window integrity
-- 0015_budget_period_utc_window_integrity.sql
--
-- Necessity: V1.2 budget granularity (HOUR / UTC_DAY / UTC_MONTH) must mean canonical
-- UTC windows. A row labelled UTC_DAY must not span a year. Enforced for both
-- reward_budget_periods and membership_bonus_budget_periods.
-- Does NOT edit migrations 0001–0014.

BEGIN;

CREATE OR REPLACE FUNCTION app_budget_period_window_is_canonical(
    granularity budget_period_granularity,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE granularity
        WHEN 'HOUR' THEN
            (period_start AT TIME ZONE 'UTC') = date_trunc('hour', period_start AT TIME ZONE 'UTC')
            AND period_end = period_start + INTERVAL '1 hour'
        WHEN 'UTC_DAY' THEN
            (period_start AT TIME ZONE 'UTC') = date_trunc('day', period_start AT TIME ZONE 'UTC')
            AND period_end = period_start + INTERVAL '1 day'
        WHEN 'UTC_MONTH' THEN
            (period_start AT TIME ZONE 'UTC') = date_trunc('month', period_start AT TIME ZONE 'UTC')
            AND period_end = (
                (date_trunc('month', period_start AT TIME ZONE 'UTC') + INTERVAL '1 month')
                AT TIME ZONE 'UTC'
            )
        ELSE FALSE
    END;
$$;

COMMENT ON FUNCTION app_budget_period_window_is_canonical(budget_period_granularity, TIMESTAMPTZ, TIMESTAMPTZ) IS
    'Phase 5 correction: HOUR = exact UTC hour→+1h; UTC_DAY = UTC midnight→next midnight; '
    'UTC_MONTH = first of month UTC→first of next month UTC.';

ALTER TABLE reward_budget_periods
    ADD CONSTRAINT reward_budget_periods_canonical_utc_window
    CHECK (app_budget_period_window_is_canonical(granularity, period_start, period_end));

ALTER TABLE membership_bonus_budget_periods
    ADD CONSTRAINT membership_bonus_budget_periods_canonical_utc_window
    CHECK (app_budget_period_window_is_canonical(granularity, period_start, period_end));

INSERT INTO schema_migrations (version)
VALUES ('0015_budget_period_utc_window_integrity')
ON CONFLICT (version) DO NOTHING;

COMMIT;
