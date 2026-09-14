# Phase 10 Acceptance Report — TON Testnet Payout Foundation

**Status:** **PHASE 10 CODE COMPLETE — LIVE VALIDATION READY (NOT CLOSED)**

P0 software blockers from the FULL REVIEW remediation pass are addressed in-tree
with focused tests green. Live controlled Testnet campaign evidence is still
required before Phase 10 can close. **No claim of Phase 10 PASS.** No real
Testnet broadcast performed in this remediation. Phase 11 not started.
Final archive remains **refused** until authoritative live campaign evidence
passes `evaluatePhase10AcceptanceFromEvidence` and Owner review.

## Owner external resources still required (only)

1. **Owner-approved Testnet Jetton master** → `TON_TESTNET_JETTON_MASTER` (never invent; never Mainnet USDT).
2. **Primary provider** → `TON_PRIMARY_PROVIDER_KIND` + `TON_PRIMARY_PROVIDER_URL` + optional `TON_PRIMARY_PROVIDER_API_KEY`.
3. **Independent secondary provider** (reconciliation campaign) → `TON_SECONDARY_PROVIDER_KIND` + `TON_SECONDARY_PROVIDER_URL` + optional `TON_SECONDARY_PROVIDER_API_KEY`.
4. **Funded Testnet Wallet V5 R1 Hot Wallet** + `hot_wallets.payout_jetton_wallet_address`.
5. **Signer encrypted bundle / unlock** for Testnet sign windows.
6. **Enable flags only after (1)–(5)** → `WITHDRAWAL_REAL_CHAIN_ENABLED=true` and `WITHDRAWAL_FAKE_CHAIN_ENABLED=false`.
7. **Do not authorize Mainnet** (`networkGlobalId=-239` / MAINNET codes remain forbidden).

## What landed (foundation correction)

| Area                        | Change                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration `0021`            | Unchanged; no `0022` required                                                                                                                 |
| `@alex-rewards/ton`         | `TonCenterTestnetProvider` + `TonApiTestnetProvider` (documented APIs); `HttpTonProvider` removed/deprecated                                  |
| `@alex-rewards/withdrawals` | Full real pipeline stages (lease → seqno → attempt → sign → persist BOC → sendBoc → evidence → TEP-74 → CONFIRMED); dual provider auth config |
| Signer                      | `GET /v1/signing-identity` (public key only; no broadcast)                                                                                    |
| CI                          | Dedicated `pnpm test:phase10` step                                                                                                            |
| Config / `.env.example`     | Independent primary/secondary kind/url/api key                                                                                                |

## Explicit non-claims

- No real Testnet broadcast performed
- No Phase 10 archive claiming PASS
- No Phase 11 work started
- No Mainnet
- No AWS KMS / plaintext keys

## Operational tooling (IN PROGRESS — no live yet)

Read-only / dry-run helpers landed in `@alex-rewards/withdrawals` (not a Phase 10 close):

| Tool | Purpose |
| --- | --- |
| `runPhase10Readiness` / `phase10:readiness` | PASS/WARN/BLOCKED inspector + summary |
| `runPhase10Preflight` / `phase10:preflight` | Aggregates readiness + restore → READY vs BLOCKED |
| `runPhase10RestoreReconcileScan` / `phase10:restore-reconcile` | Post-restore scan; never auto-resend / never unpause |
| `buildPhase10HotWalletMonitorReport` / `phase10:hot-wallet-monitor` | Hot wallet identity + injected balance observations |
| `planPhase10Campaign` / `phase10:campaign-plan` | Dry-run scenario matrix only |
| `checkPhase10PayoutInvariants` | Per-withdrawal reservation / settlement / TEP-74 proof checks |
| `evaluatePhase10AcceptanceGate` / `evaluatePhase10AcceptanceFromEvidence` | Path-only refuses; authoritative gate verifies campaign JSON + DB invariants |
| Approved outbox claim | `FOR UPDATE SKIP LOCKED` + Temporal workflow id (no `available_at` bump fencing) |

**Still blocked for live execution** on Owner external resources (Jetton master, providers, funded Hot Wallet,
signer unlock window) before any controlled live Testnet. Phase 10 remains **not closed**.
