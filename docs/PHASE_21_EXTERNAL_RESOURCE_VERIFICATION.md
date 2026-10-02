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
