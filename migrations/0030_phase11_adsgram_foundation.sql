-- ALEx Rewards — Phase 11 AdsGram + Provider Framework Foundation
-- 0030_phase11_adsgram_foundation.sql
--
-- Corrects Phase 2 quote↔session FK direction to Spec V1.3:
--   reward_quotes.ad_session_id is the sole authoritative FK (UNIQUE).
--   ad_sessions.reward_quote_id remains a compatibility mirror only.
-- Seeds AdsGram provider with production_monetary_status = BLOCKED and
-- versioned REQUEST=30 / SUCCESS=25 limit rules (data, not code constants).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Authoritative FK: reward_quotes.ad_session_id
-- ---------------------------------------------------------------------------

ALTER TABLE reward_quotes
    ADD COLUMN IF NOT EXISTS ad_session_id UUID NULL
        REFERENCES ad_sessions (id) ON DELETE RESTRICT;

COMMENT ON COLUMN reward_quotes.ad_session_id IS
    'Sole authoritative FK from quote → ad session (Spec V1.3 §21.3). '
    'Pre-generated with the session in one transaction. UNIQUE when set. '
    'ad_sessions.reward_quote_id is a deprecated mirror only.';

-- Backfill from legacy reverse links (Phase 2 deviation).
UPDATE reward_quotes rq
SET ad_session_id = s.id
FROM ad_sessions s
WHERE s.reward_quote_id = rq.id
  AND rq.ad_session_id IS NULL;

-- Secondary: AD quotes whose source_id already equals a session id.
UPDATE reward_quotes rq
SET ad_session_id = s.id
FROM ad_sessions s
WHERE rq.source_type = 'AD'
  AND rq.source_id = s.id
  AND rq.ad_session_id IS NULL
  AND (s.reward_quote_id IS NULL OR s.reward_quote_id = rq.id);

-- Ambiguity gate: conflicting session↔quote mappings fail closed.
DO $$
DECLARE
    conflict_count INTEGER;
BEGIN
    SELECT count(*)::int INTO conflict_count
    FROM ad_sessions s
    JOIN reward_quotes rq ON rq.id = s.reward_quote_id
    WHERE rq.ad_session_id IS NOT NULL
      AND rq.ad_session_id <> s.id;

    IF conflict_count > 0 THEN
        RAISE EXCEPTION
            'Phase 11 FK migration ambiguity: % sessions have reward_quote_id pointing at a quote whose ad_session_id is a different session',
            conflict_count;
    END IF;

    SELECT count(*)::int INTO conflict_count
    FROM reward_quotes rq
    WHERE rq.source_type = 'AD'
      AND rq.ad_session_id IS NOT NULL
      AND rq.source_id <> rq.ad_session_id;

    IF conflict_count > 0 THEN
        RAISE EXCEPTION
            'Phase 11 FK migration ambiguity: % AD quotes have source_id <> ad_session_id',
            conflict_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS reward_quotes_ad_session_uidx
    ON reward_quotes (ad_session_id)
    WHERE ad_session_id IS NOT NULL;

ALTER TABLE reward_quotes
    DROP CONSTRAINT IF EXISTS reward_quotes_ad_source_session_check;

ALTER TABLE reward_quotes
    ADD CONSTRAINT reward_quotes_ad_source_session_check
    CHECK (
        source_type <> 'AD'
        OR (ad_session_id IS NOT NULL AND source_id = ad_session_id)
    );

-- ---------------------------------------------------------------------------
-- 2. Provider health snapshots (append-oriented operational state)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    CREATE TYPE provider_health_status AS ENUM (
        'HEALTHY',
        'DEGRADED',
        'UNAVAILABLE',
        'SUSPENDED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE provider_health_snapshots (
    id              UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id     UUID NOT NULL REFERENCES ad_providers (id) ON DELETE CASCADE,
    status          provider_health_status NOT NULL,
    reason_code     TEXT NOT NULL,
    details_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE provider_health_snapshots IS
    'Normalized provider health observations. Latest row controls NEW session authorization; '
    'never rewrites historical session outcomes or already-earned rewards (Phase 11).';

CREATE INDEX provider_health_snapshots_latest_idx
    ON provider_health_snapshots (provider_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- 3. AdsGram clarification register (auditable unresolved questions)
-- ---------------------------------------------------------------------------

CREATE TABLE provider_clarification_items (
    id                UUID PRIMARY KEY DEFAULT app_generate_uuid(),
    provider_id       UUID NOT NULL REFERENCES ad_providers (id) ON DELETE CASCADE,
    item_code         TEXT NOT NULL,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN', 'RESOLVED', 'WAIVED')),
    detail            TEXT NOT NULL,
    evidence_reference TEXT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ NULL,
    CONSTRAINT provider_clarification_items_code_key UNIQUE (provider_id, item_code)
);

COMMENT ON TABLE provider_clarification_items IS
    'Unresolved provider production-monetary clarification questions. '
    'Phase 11 implementation completion does NOT equal production-money approval.';

CREATE TRIGGER provider_clarification_items_set_updated_at
    BEFORE UPDATE ON provider_clarification_items
    FOR EACH ROW EXECUTE FUNCTION app_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. System policy approver (for PROVIDER_HARD ACTIVE rule seed only)
-- ---------------------------------------------------------------------------

INSERT INTO admin_users (id, email, display_name, status)
VALUES (
    'a11a11a1-0000-4000-8000-000000000011',
    'phase11-policy@alex-rewards.internal',
    'Phase 11 Policy Seed Approver',
    'ACTIVE'
)
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. AdsGram provider + manifest + unit + limits + clarification + health
-- ---------------------------------------------------------------------------

INSERT INTO ad_providers (
    id, code, name, status, lifecycle_state, production_monetary_status,
    capabilities, policy_reference, rewarded_use_allowed, incentivized_crypto_allowed,
    server_verification_supported, restricted_categories_reference
) VALUES (
    'a11a11a1-0000-4000-8000-00000000ad51',
    'ADSGRAM',
    'AdsGram',
    'ACTIVE',
    'SANDBOX',
    'BLOCKED',
    jsonb_build_object(
        'rewarded', true,
        'interstitial', true,
        'taskAds', true,
        'serverRewardCallback', true,
        'uniqueProviderEventId', 'UNKNOWN',
        'serverSignalAuthentication', 'NONE',
        'sessionOrImpressionCorrelation', 'UNKNOWN',
        'retryBehaviorDocumented', false,
        'deliveryWindowDocumented', false,
        'providerSideRequestLimit', 'UNKNOWN',
        'countryReporting', true,
        'revenueReportingApi', true,
        'cashRewardPolicyApproved', false,
        'productionMonetaryStatus', 'BLOCKED',
        'clarificationGate', 'OPEN'
    ),
    'docs/ADSGRAM_CLARIFICATION_REGISTER.md',
    true,
    false,
    false,
    'Owner must confirm Adult/Gambling disablement before monetary approval'
)
ON CONFLICT (code) DO UPDATE SET
    production_monetary_status = EXCLUDED.production_monetary_status,
    capabilities = EXCLUDED.capabilities,
    updated_at = now();

INSERT INTO ad_provider_manifests (
    id, provider_id, manifest_version, environment, adapter_version,
    supported_formats, rewarded_supported, server_reward_signal_supported,
    server_signal_authentication, unique_event_id_supported,
    session_correlation_supported, custom_nonce_supported,
    retry_delivery_documented, provider_side_limit_supported,
    reporting_api_supported, revenue_reporting_supported, country_reporting_supported,
    credentials_reference, policy_status, production_monetary_status, status
) VALUES (
    'a11a11a1-0000-4000-8000-000000000f01',
    'a11a11a1-0000-4000-8000-00000000ad51',
    1,
    'PRODUCTION',
    '1.0.0-phase11',
    ARRAY['REWARDED_VIDEO']::ad_format[],
    true,
    true,
    'NONE',
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    'secret://adsgram/reward-url-credentials',
    'BLOCKED_PENDING_CLARIFICATION',
    'BLOCKED',
    'ACTIVE'
)
ON CONFLICT (provider_id, environment, manifest_version) DO NOTHING;

INSERT INTO ad_provider_manifests (
    id, provider_id, manifest_version, environment, adapter_version,
    supported_formats, rewarded_supported, server_reward_signal_supported,
    server_signal_authentication, unique_event_id_supported,
    session_correlation_supported, custom_nonce_supported,
    retry_delivery_documented, provider_side_limit_supported,
    reporting_api_supported, revenue_reporting_supported, country_reporting_supported,
    credentials_reference, policy_status, production_monetary_status, status
) VALUES (
    'a11a11a1-0000-4000-8000-000000000f02',
    'a11a11a1-0000-4000-8000-00000000ad51',
    1,
    'STAGING',
    '1.0.0-phase11',
    ARRAY['REWARDED_VIDEO']::ad_format[],
    true,
    true,
    'NONE',
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    'secret://adsgram/reward-url-credentials',
    'BLOCKED_PENDING_CLARIFICATION',
    'BLOCKED',
    'ACTIVE'
)
ON CONFLICT (provider_id, environment, manifest_version) DO NOTHING;

INSERT INTO ad_units (
    id, provider_id, provider_block_id, placement_code, format, environment, status,
    client_config, server_config
) VALUES (
    'a11a11a1-0000-4000-8000-000000000a11',
    'a11a11a1-0000-4000-8000-00000000ad51',
    'OWNER_CONFIGURED_BLOCK_ID',
    'earn_rewarded_primary',
    'REWARDED_VIDEO',
    'STAGING',
    'ACTIVE',
    '{"blockIdPlaceholder": true}'::jsonb,
    '{"rewardUrlPath": "/webhooks/adsgram/reward"}'::jsonb
)
ON CONFLICT (provider_id, environment, placement_code) DO NOTHING;

-- REQUEST / UTC_DAY provider hard = 30 (versioned data)
INSERT INTO provider_limit_rules (
    id, provider_id, limit_scope, limit_metric, limit_window,
    max_count, rule_version, status, valid_from,
    source_type, source_reference, reason,
    approved_by_admin_id, approved_at
) VALUES (
    'a11a11a1-0000-4000-8000-0000000011a1',
    'a11a11a1-0000-4000-8000-00000000ad51',
    'PROVIDER_HARD',
    'REQUEST',
    'UTC_DAY',
    30,
    1,
    'ACTIVE',
    timestamptz '2024-01-01 00:00:00+00',
    'WRITTEN_SUPPORT',
    'AdsGram support written answer: 30 provider requests/user/UTC day for this business model',
    'Phase 11 seed: current approved AdsGram request safety value',
    'a11a11a1-0000-4000-8000-000000000011',
    now()
)
ON CONFLICT (id) DO NOTHING;
-- (REQUEST hard rule id conflict handled above)

-- SUCCESS / UTC_DAY platform soft = 25 (versioned data)
INSERT INTO provider_limit_rules (
    id, provider_id, limit_scope, limit_metric, limit_window,
    max_count, rule_version, status, valid_from,
    source_type, source_reference, reason,
    approved_by_admin_id, approved_at
) VALUES (
    'a11a11a1-0000-4000-8000-0000000011a2',
    'a11a11a1-0000-4000-8000-00000000ad51',
    'PLATFORM_SOFT',
    'SUCCESS',
    'UTC_DAY',
    25,
    1,
    'ACTIVE',
    timestamptz '2024-01-01 00:00:00+00',
    'OFFICIAL_DOCUMENTATION',
    'ALEx Spec V1.3: platform visible successful opportunity default 25/user/UTC day',
    'Phase 11 seed: platform successful rewarded ads default',
    'a11a11a1-0000-4000-8000-000000000011',
    now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO provider_health_snapshots (provider_id, status, reason_code, details_redacted)
VALUES (
    'a11a11a1-0000-4000-8000-00000000ad51',
    'HEALTHY',
    'PHASE11_FOUNDATION_DEFAULT',
    '{"note": "Foundation default; does not authorize production money"}'::jsonb
);

INSERT INTO provider_clarification_items (provider_id, item_code, title, status, detail) VALUES
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'REWARD_URL_AUTHENTICITY',
    'Reward URL authenticity / signature',
    'OPEN',
    'Documented AdsGram Reward URL may lack cryptographic signature. Unsigned/weakly correlated signals must not create production money.'
),
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'SESSION_CORRELATION',
    'Per-impression / session correlation',
    'OPEN',
    'Unambiguous per-impression/session correlation identity from provider is not confirmed.'
),
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'RETRY_SEMANTICS',
    'Retry semantics',
    'OPEN',
    'Provider retry/idempotency behaviour for Reward URL delivery is not authoritatively documented for this integration.'
),
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'DELIVERY_WINDOW',
    'Delivery window / order',
    'OPEN',
    'Delivery window and out-of-order server signal guarantees remain unresolved.'
),
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'PROVIDER_SIDE_REQUEST_LIMIT',
    'Provider-side request limiting',
    'OPEN',
    'Preferred authoritative request counting is provider-side; browser-to-provider request proof remains ambiguous.'
),
(
    'a11a11a1-0000-4000-8000-00000000ad51',
    'MODERATION_COMPLIANCE',
    'Moderation / compliance evidence',
    'OPEN',
    'Adult/Gambling disablement and moderation approval evidence still outstanding for production monetary use.'
)
ON CONFLICT (provider_id, item_code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('0030_phase11_adsgram_foundation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
