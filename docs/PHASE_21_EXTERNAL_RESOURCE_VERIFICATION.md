# Phase 21 - External Resource Verification (Read-Only)

Helpers in `packages/withdrawals/src/phase21-external-probes.ts`.

## Static validation

- Jetton master parse + forbidden placeholder rejection
- Provider independence (kind+url not identical)

## Optional live probes

HTTP reachability only when `PHASE21_EXTERNAL_PROBE_LIVE=1`. No `sendBoc`. Unit tests mock by default.

## Step 3 posture

- Mainnet USDT Jetton master still **absent** operationally (OWNER_EXTERNAL_RESOURCE_REQUIRED).
- Independent primary/secondary Mainnet providers still **unconfigured**.
- Probes do not authorize funding, unlock, unpause, or live payout.
- Preflight may reach `READY_FOR_OWNER_PROVISIONING_CEREMONY` while these remain BLOCKED.


## Step 3A hardening (P21-S3A-004)

- Provider independence requires different vendor kind AND different normalized hostname (aliases fail).
- Probe provenance includes providerKind, providerHost, networkIdentity, observedAt, resource, verificationMethod, ok.
- Bare HTTP 200 is never Mainnet identity; identity adapter or incomplete/unavailable.
- erifyMainnetUsdtWithTwoProviders fail-closed orchestration is available for Owner ceremony use (offline unit-tested with mocks).

## Step 3B concrete adapters

- packages/ton/src/toncenter-mainnet-readonly.ts
- packages/ton/src/tonapi-mainnet-readonly.ts
- Factory: createPhase21MainnetExternalAdapters in withdrawals
- CLI: pnpm phase21:verify-mainnet-external
- Fee: ToncenterMainnetFeeProvider + pnpm phase21:estimate-mainnet-fee
- Never broadcast / never sendBoc; API keys redacted to hostname in errors

## Phase 21 Step 3C final operational truth gate

Toncenter metadata uses indexed v3 jetton/masters (not get_jetton_data alone). Verification classes: VERIFIED_PROVIDER_MAINNET_ENDPOINT vs PROVEN_FROM_CHAIN_RESPONSE. Provider URLs must pass SSRF/allowlist hardening. Dual-provider observedJettonMaster must equal requested master.

