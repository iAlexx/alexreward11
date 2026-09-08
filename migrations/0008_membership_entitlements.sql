-- ALEx Rewards — Phase 2 Database Baseline
-- 0008_membership_entitlements.sql
--
-- Scope: membership plans, entitlements, versioned benefit rules, plan/entitlement
-- bindings, user memberships (including Founder numbering), single-use claim codes,
-- append-only grant history and membership bonus budgets.
--
-- Authority notes:
--   * Entitlements never mutate money. A benefit calls the normal reward, fee,
--     withdrawal and ledger paths (spec §156A.5).
--   * FOUNDER_LIFETIME is a membership benefit product: no equity, no ownership,
--     no guaranteed return. Nothing in this schema implies otherwise.
--   * Founder numbers are generated server-side under a unique constraint.
--   * Revocation preserves history; it never erases payment or grant records.

BEGIN;

-- ---------------------------------------------------------------------------
-- Plans and entitlements (spec §156B)
-- ---------------------------------------------------------------------------

CREATE TABLE membership_plans (
    id             UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code           TEXT NOT NULL,
    name           TEXT NOT NULL,
    billing_model  membership_billing_model NOT NULL DEFAULT 'FREE',
    price_currency TEXT NULL,
    price_decimals SMALLINT NULL CHECK (price_decimals BETWEEN 0 AND 18),
    price_atomic   BIGINT NULL CHECK (price_atomic > 0),
    is_lifetime    BOOLEAN NOT NULL DEFAULT false,
    status         activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_plans_code_key UNIQUE (code),
    CONSTRAINT membership_plans_price_is_complete
        CHECK (num_nonnulls(price_currency, price_decimals, price_atomic) IN (0, 3)),
    CONSTRAINT membership_plans_free_has_no_price
        CHECK (billing_model <> 'FREE' OR price_atomic IS NULL)
);

COMMENT ON TABLE membership_plans IS
    'Membership products (STANDARD, FOUNDER_LIFETIME, future tiers). The price is a fiat '
    'catalogue price in atomic units of price_currency, not an in-ledger balance.';

CREATE TRIGGER membership_plans_set_updated_at
    BEFORE UPDATE ON membership_plans
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE entitlements (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code                    TEXT NOT NULL,
    name                    TEXT NOT NULL,
    value_type              entitlement_value_type NOT NULL,
    security_classification entitlement_security_classification NOT NULL DEFAULT 'INTERNAL',
    description             TEXT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT entitlements_code_key UNIQUE (code)
);

COMMENT ON TABLE entitlements IS
    'Typed benefit definitions resolved by the entitlement resolver. Scattered '
    '"if user.isFounder" behaviour is forbidden (spec §156A.5).';

CREATE TRIGGER entitlements_set_updated_at
    BEFORE UPDATE ON entitlements
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE membership_benefit_rule_versions (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    entitlement_id      UUID NOT NULL REFERENCES entitlements (id) ON DELETE RESTRICT,
    membership_plan_id  UUID NULL REFERENCES membership_plans (id) ON DELETE RESTRICT,
    rule_version        INTEGER NOT NULL CHECK (rule_version > 0),
    value_boolean       BOOLEAN NULL,
    value_bps           INTEGER NULL CHECK (value_bps BETWEEN 0 AND 10000),
    value_integer       BIGINT NULL,
    value_atomic        BIGINT NULL CHECK (value_atomic >= 0),
    value_enum          TEXT NULL,
    asset_id            UUID NULL REFERENCES assets (id) ON DELETE RESTRICT,
    is_grandfathered    BOOLEAN NOT NULL DEFAULT false,
    status              rule_version_status NOT NULL DEFAULT 'DRAFT',
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to        TIMESTAMPTZ NULL,
    reason              TEXT NULL,
    source_reference    TEXT NULL,
    created_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_by_admin_id UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    approved_at         TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_benefit_rule_versions_key
        UNIQUE NULLS NOT DISTINCT (entitlement_id, membership_plan_id, rule_version),
    CONSTRAINT membership_benefit_rule_versions_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),
    -- Exactly one typed value must be populated for the entitlement's value_type.
    CONSTRAINT membership_benefit_rule_versions_single_value
        CHECK (
            num_nonnulls(value_boolean, value_bps, value_integer, value_atomic, value_enum) = 1
        )
);

COMMENT ON TABLE membership_benefit_rule_versions IS
    'Immutable versioned benefit values (for example the Founder reward bonus in bps). '
    'Every benefit evaluation stays reconstructable from these versions (spec §156A.10). '
    'Launch values require explicit Owner approval and are never seeded here.';

CREATE INDEX membership_benefit_rule_versions_active_idx
    ON membership_benefit_rule_versions (entitlement_id, membership_plan_id, effective_from DESC)
    WHERE status = 'ACTIVE';

CREATE TABLE membership_plan_entitlements (
    id                 UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    membership_plan_id UUID NOT NULL REFERENCES membership_plans (id) ON DELETE CASCADE,
    entitlement_id     UUID NOT NULL REFERENCES entitlements (id) ON DELETE RESTRICT,
    rule_version_id    UUID NOT NULL
                       REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    valid_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to           TIMESTAMPTZ NULL,
    status             rule_version_status NOT NULL DEFAULT 'ACTIVE',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_plan_entitlements_version_key
        UNIQUE (membership_plan_id, entitlement_id, rule_version_id),
    CONSTRAINT membership_plan_entitlements_window
        CHECK (valid_to IS NULL OR valid_to > valid_from),
    -- A plan resolves at most one active value per entitlement at any instant.
    CONSTRAINT membership_plan_entitlements_no_active_overlap
        EXCLUDE USING gist (
            membership_plan_id WITH =,
            entitlement_id WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE')
);

COMMENT ON TABLE membership_plan_entitlements IS
    'Binds a plan to the versioned value of an entitlement for an effective window.';

CREATE TRIGGER membership_plan_entitlements_set_updated_at
    BEFORE UPDATE ON membership_plan_entitlements
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- User memberships and Founder identity (spec §156A.3, §156B)
-- ---------------------------------------------------------------------------

-- Founder numbers are permanent and sequential, generated server-side only.
CREATE SEQUENCE founder_number_seq AS INTEGER START WITH 1 INCREMENT BY 1;

CREATE TABLE user_memberships (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_id                   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    membership_plan_id        UUID NOT NULL REFERENCES membership_plans (id) ON DELETE RESTRICT,
    founder_number            INTEGER NULL CHECK (founder_number > 0),
    status                    membership_status NOT NULL DEFAULT 'ACTIVE',
    source                    membership_source NOT NULL,
    purchase_currency         TEXT NULL,
    purchase_decimals         SMALLINT NULL CHECK (purchase_decimals BETWEEN 0 AND 18),
    purchase_amount_atomic    BIGINT NULL CHECK (purchase_amount_atomic > 0),
    payment_reference_redacted TEXT NULL,
    granted_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at                TIMESTAMPTZ NULL,
    expires_at                TIMESTAMPTZ NULL,
    revoked_at                TIMESTAMPTZ NULL,
    revocation_reason         TEXT NULL,
    created_by_admin_id       UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Founder numbers are unique and permanent. NULL for non-Founder memberships.
    CONSTRAINT user_memberships_founder_number_key UNIQUE (founder_number),
    CONSTRAINT user_memberships_purchase_is_complete
        CHECK (num_nonnulls(purchase_currency, purchase_decimals, purchase_amount_atomic) IN (0, 3)),
    CONSTRAINT user_memberships_revocation_consistent
        CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

COMMENT ON TABLE user_memberships IS
    'A membership granted to one validated Telegram user. Lifetime memberships have '
    'expires_at NULL. Restricting misuse uses status, never deletion of history.';
COMMENT ON COLUMN user_memberships.founder_number IS
    'Permanent sequential Founder number from founder_number_seq, unique across all rows '
    'and never generated on the frontend (spec §156A.3).';

-- One active membership per plan per user; history rows remain queryable.
CREATE UNIQUE INDEX user_memberships_one_active_per_plan_idx
    ON user_memberships (user_id, membership_plan_id)
    WHERE status = 'ACTIVE';

CREATE INDEX user_memberships_user_idx ON user_memberships (user_id, status);
CREATE INDEX user_memberships_plan_idx ON user_memberships (membership_plan_id, status);

CREATE TRIGGER user_memberships_set_updated_at
    BEFORE UPDATE ON user_memberships
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Claim codes (spec §156A.8)
-- ---------------------------------------------------------------------------

CREATE TABLE membership_claim_codes (
    id                      UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    code_hash               TEXT NOT NULL,
    membership_plan_id      UUID NOT NULL REFERENCES membership_plans (id) ON DELETE RESTRICT,
    founder_number_reserved INTEGER NULL CHECK (founder_number_reserved > 0),
    issued_for_reference    TEXT NULL,
    expires_at              TIMESTAMPTZ NULL,
    consumed_at             TIMESTAMPTZ NULL,
    consumed_by_user_id     UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
    granted_membership_id   UUID NULL REFERENCES user_memberships (id) ON DELETE RESTRICT,
    created_by_admin_id     UUID NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Only the hash of the claim secret is stored; the plaintext code never is.
    CONSTRAINT membership_claim_codes_code_hash_key UNIQUE (code_hash),
    CONSTRAINT membership_claim_codes_reserved_number_key UNIQUE (founder_number_reserved),
    -- Single-use: consumption is one atomic step that binds user, time and grant.
    CONSTRAINT membership_claim_codes_consumption_atomic
        CHECK (
            (consumed_at IS NULL
                AND consumed_by_user_id IS NULL
                AND granted_membership_id IS NULL)
            OR (consumed_at IS NOT NULL
                AND consumed_by_user_id IS NOT NULL
                AND granted_membership_id IS NOT NULL)
        ),
    -- One claim code can back exactly one membership grant.
    CONSTRAINT membership_claim_codes_grant_key UNIQUE (granted_membership_id)
);

COMMENT ON TABLE membership_claim_codes IS
    'Owner-issued one-time Founder claim codes. Cryptographically unpredictable, hashed at '
    'rest, server-validated, single-use, atomically consumed and audited (spec §156A.8).';

-- A user may consume at most one claim code, ever.
CREATE UNIQUE INDEX membership_claim_codes_one_per_user_idx
    ON membership_claim_codes (consumed_by_user_id)
    WHERE consumed_by_user_id IS NOT NULL;

CREATE INDEX membership_claim_codes_open_idx
    ON membership_claim_codes (membership_plan_id, expires_at)
    WHERE consumed_at IS NULL;

CREATE TRIGGER membership_claim_codes_set_updated_at
    BEFORE UPDATE ON membership_claim_codes
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Grant history (spec §156B `membership_grant_events`)
-- ---------------------------------------------------------------------------

CREATE TABLE membership_grant_events (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    user_membership_id  UUID NOT NULL REFERENCES user_memberships (id) ON DELETE RESTRICT,
    event_type          membership_grant_event_type NOT NULL,
    from_user_id        UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
    to_user_id          UUID NULL REFERENCES users (id) ON DELETE RESTRICT,
    claim_code_id       UUID NULL REFERENCES membership_claim_codes (id) ON DELETE RESTRICT,
    actor_admin_id      UUID NULL REFERENCES admin_users (id) ON DELETE SET NULL,
    actor_source        actor_source NOT NULL DEFAULT 'SYSTEM',
    reason              TEXT NULL,
    before_snapshot     JSONB NULL,
    after_snapshot      JSONB NULL,
    audit_log_id        UUID NULL REFERENCES audit_logs (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE membership_grant_events IS
    'Append-only grant/claim/reassignment/status history. Exceptional reassignment requires '
    'Owner reauthentication, a reason and before/after audit (spec §156A.9).';

CREATE INDEX membership_grant_events_membership_idx
    ON membership_grant_events (user_membership_id, created_at DESC);

CREATE TRIGGER membership_grant_events_reject_update
    BEFORE UPDATE ON membership_grant_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

CREATE TRIGGER membership_grant_events_reject_delete
    BEFORE DELETE ON membership_grant_events
    FOR EACH ROW EXECUTE FUNCTION app_reject_row_mutation();

-- ---------------------------------------------------------------------------
-- Membership bonus budgets (spec §156A.6, §156A.7)
-- ---------------------------------------------------------------------------

CREATE TABLE membership_bonus_budget_periods (
    id                  UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    membership_plan_id  UUID NULL REFERENCES membership_plans (id) ON DELETE RESTRICT,
    user_id             UUID NULL REFERENCES users (id) ON DELETE CASCADE,
    asset_id            UUID NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    granularity         budget_period_granularity NOT NULL,
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    budget_atomic       BIGINT NOT NULL CHECK (budget_atomic > 0),
    per_user_cap_atomic BIGINT NULL CHECK (per_user_cap_atomic > 0),
    reserved_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
    consumed_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (consumed_atomic >= 0),
    released_atomic     BIGINT NOT NULL DEFAULT 0 CHECK (released_atomic >= 0),
    status              activation_status NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_bonus_budget_periods_key
        UNIQUE NULLS NOT DISTINCT
            (membership_plan_id, user_id, asset_id, granularity, period_start),
    CONSTRAINT membership_bonus_budget_periods_window CHECK (period_end > period_start),
    CONSTRAINT membership_bonus_budget_periods_projection_bounded
        CHECK (reserved_atomic + consumed_atomic <= budget_atomic)
);

COMMENT ON TABLE membership_bonus_budget_periods IS
    'Daily/monthly, per-user, per-plan and global membership bonus budgets. An unavailable '
    'bonus budget must never corrupt a valid base reward (spec §156A.7).';

CREATE TRIGGER membership_bonus_budget_periods_set_updated_at
    BEFORE UPDATE ON membership_bonus_budget_periods
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

CREATE TABLE membership_bonus_budget_reservations (
    id                        UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    budget_period_id          UUID NOT NULL
                              REFERENCES membership_bonus_budget_periods (id) ON DELETE RESTRICT,
    user_membership_id        UUID NOT NULL REFERENCES user_memberships (id) ON DELETE RESTRICT,
    reward_quote_id           UUID NULL REFERENCES reward_quotes (id) ON DELETE RESTRICT,
    originating_reward_event_id UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    bonus_reward_event_id     UUID NULL REFERENCES reward_events (id) ON DELETE RESTRICT,
    entitlement_rule_version_id UUID NOT NULL
                              REFERENCES membership_benefit_rule_versions (id) ON DELETE RESTRICT,
    bonus_rule_version        INTEGER NOT NULL,
    amount_atomic             BIGINT NOT NULL CHECK (amount_atomic > 0),
    state                     budget_reservation_state NOT NULL DEFAULT 'ACTIVE',
    reserved_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at               TIMESTAMPTZ NULL,
    consumed_at               TIMESTAMPTZ NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_bonus_budget_reservations_quote_key UNIQUE (reward_quote_id),
    CONSTRAINT membership_bonus_budget_reservations_origin_key
        UNIQUE (originating_reward_event_id),
    CONSTRAINT membership_bonus_budget_reservations_bonus_key UNIQUE (bonus_reward_event_id),
    CONSTRAINT membership_bonus_budget_reservations_state_consistent
        CHECK (
            (state = 'ACTIVE' AND released_at IS NULL AND consumed_at IS NULL)
            OR (state = 'RELEASED' AND released_at IS NOT NULL AND consumed_at IS NULL)
            OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL)
        )
);

COMMENT ON TABLE membership_bonus_budget_reservations IS
    'Carries the audit fields a Founder bonus must retain: originating reward, membership, '
    'entitlement version, bonus rule version, amount and budget period. The bonus is '
    'platform-funded and must never be recorded as provider-funded revenue.';

CREATE INDEX membership_bonus_budget_reservations_period_idx
    ON membership_bonus_budget_reservations (budget_period_id, state);

CREATE TRIGGER membership_bonus_budget_reservations_set_updated_at
    BEFORE UPDATE ON membership_bonus_budget_reservations
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- Deferred foreign keys from migrations 0003 and 0006
-- ---------------------------------------------------------------------------

ALTER TABLE reward_quotes
    ADD CONSTRAINT reward_quotes_membership_fkey
        FOREIGN KEY (membership_id) REFERENCES user_memberships (id) ON DELETE RESTRICT;

ALTER TABLE mission_versions
    ADD CONSTRAINT mission_versions_required_membership_plan_fkey
        FOREIGN KEY (required_membership_plan_id)
        REFERENCES membership_plans (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (version)
VALUES ('0008_membership_entitlements')
ON CONFLICT (version) DO NOTHING;

COMMIT;
