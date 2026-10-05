# Phase 21 Step 3C — Final Operational Truth Gate

**Status:** SOURCE / TEST / READINESS implemented — **not operationally executed**
**Scope:** ceremony truth gates only
**Forbidden:** deploy, real keys, operational DB mutation, funding, payout

## Defect / gate IDs

| ID | Summary |
| --- | --- |
| P21-S3C-001 | Toncenter USDT metadata via v3 indexed jetton/masters + get_jetton_data reachability; two-provider PASS requires both ok, USDT/6, observed master equals requested |
| P21-S3C-002 | Real Jetton fee estimation with unsigned TEP-74 body; distinct fee vs candidate attached vs forward; exposure = attached + forward (fee separate) |
| P21-S3C-003 | Remove hardcoded USDT master fallback; require TON_MAINNET_USDT_JETTON_MASTER for PLAN and APPLY |
| P21-S3C-004 | Live PLAN requires DATABASE_URL; refuse LIVE_DATABASE_REQUIRED_FOR_PLAN; optional :template commands are SCHEMA_TEMPLATE_NOT_LIVE |
| P21-S3C-005 | APPLY requires ACTIVE OWNER admin (PHASE21_CEREMONY_ADMIN_USER_ID); SYSTEM/null forbidden |
| Registry audit | Same-txn audit_logs public snapshot on registry APPLY |
| Hot wallet proof | Dual-provider (or Owner-supplied evidence) jetton wallet derivation must match Owner payout address |
| SSRF | assertMainnetProviderUrl: https, no credentials/query/fragment, no RFC1918/localhost, host allowlist |
| Evidence schema | phase21-provisioning-evidence Zod schema + sanitized fixture only (no fake live evidence in repo) |

## Provider verification honesty

| Provider | Class | Method |
| --- | --- | --- |
| Toncenter | VERIFIED_PROVIDER_MAINNET_ENDPOINT | URL allowlist + getMasterchainInfo health + expectedNetworkGlobalId=-239 |
| TonAPI | PROVEN_FROM_CHAIN_RESPONSE when config body proves -239; else VERIFIED_PROVIDER_MAINNET_ENDPOINT via URL + status + expected -239 |

API keys via headers/config only — never in ceremony provider URLs.

## Fee field formula

- estimatedNetworkFeeAtomic — Toncenter estimateFee total (network fee)
- candidateAttachedGramAtomic — candidate for unsigned body construction only (NOT Owner-approved)
- forwardGramAtomic — Owner-approved 1 nanogram
- estimatedTotalNativeExposureAtomic = candidateAttached + forward (gas attachment exposure; network fee NOT double-counted)
- attachedGramLifecycle = ESTIMATED, broadcast = false

Cycle-safe: unsigned Jetton body helper lives in @alex-rewards/ton (signing already depends on ton).

## Readiness observations (must PASS for ceremony)

- twoProviderMetadataOperational
- realJettonFeeEstimation
- usdtMasterFallbackRemoved
- livePlanRequiresDatabase
- ceremonyOwnerActorRequired
- providerUrlSsrfProtection
- hotWalletDerivationProofRequired
- ceremonyEvidenceSchemaReady

READY_FOR_LIVE_PAYOUT remains always false.

## Explicit non-execution

Step 3C does not authorize deploy, ops DB mutation, funding, payout, or moving production-runtime.
