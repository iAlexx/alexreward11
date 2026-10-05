# Phase 20 — Canonical LOOTRA runtime cutover + Step 4C staging policy activation

**Date:** 2026-10-02  
**Owner authorization:** Explicit Owner ceremony for Railway canonical runtime cutover + staging DB activation of Risk/Trust/Eligibility v1 and `WITHDRAWAL_REQUESTS_PAUSE/STAGING=true`.  
**Does NOT authorize:** production money, Mainnet, payout resume, signer operation, TON broadcast, AdsGram monetary enablement, or disabling monetary safety gates.

## Runtime source

| Item                                     | Value                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Starting HEAD (`phase20-closed-beta`)    | `b9dd700de428498493fb6e497ec16901684532c0`                         |
| RUNTIME_HEAD                             | `b9dd700de428498493fb6e497ec16901684532c0`                         |
| Canonical deploy branch                  | `production-runtime` @ same SHA                                    |
| Approved policy artifact                 | `packages/fraud/policy/phase20-closed-beta-owner-approved.json`    |
| Full artifact digest                     | `8f8e4cba511900d7320ca8d80205389648d81a7778ce3b86a0add790bc039eeb` |
| `activationAuthorized` field in artifact | `false` (ceremony is external Owner authorization)                 |
| `DEPLOYMENT_ENV`                         | unchanged `staging` (Railway env name remains `production`)        |

## Railway deployments (all RUNTIME_HEAD)

| Service         | Deployment ID                          | Commit     | Health                         |
| --------------- | -------------------------------------- | ---------- | ------------------------------ |
| api-staging     | `183f0df2-57df-4ff4-9ceb-ac012813982b` | `b9dd700…` | PASS `/health/ready`           |
| worker-staging  | `16ea4c57-4ca7-4041-8854-dd48402b1de1` | `b9dd700…` | PASS localhost `/health/ready` |
| bot-staging     | `9597246d-7cd9-47f8-8582-7036941bbc80` | `b9dd700…` | PASS localhost `/health/ready` |
| miniapp-staging | `ffeafed1-5eda-4944-baed-9a3848fc8b0b` | `b9dd700…` | PASS `/`                       |
| admin-staging   | `7c1c2e94-0f2e-495f-b0d3-761c7909ef0c` | `b9dd700…` | PASS `/login`                  |

Untouched: Temporal, operational Postgres, Redis, Phase18 restore sibling.

## Bot identity

- Telegram `getMe` username: `LOOTRAbot` (matches `LOOTRABOT` case-insensitive)
- Transport: polling; single intended bot runtime; no second bot created by this task
- Mini App URL: `https://miniapp-staging-production.up.railway.app`
- Token not printed/rotated

## Schema migrations

Operational Postgres `schema_migrations` matched RUNTIME_HEAD (58/58). No unexpected migrations introduced by deploy.

## Pre-activation DB state

Risk/Trust/Eligibility totals ACTIVE = 0/0/0.  
`WITHDRAWAL_REQUESTS_PAUSE/STAGING` = MISSING.  
`PAYOUT_DISPATCH_PAUSE/STAGING` = true.  
`REFERRAL_REWARD_PAUSE/STAGING` = true.  
AdsGram lifecycle = SANDBOX; production monetary = BLOCKED.

## Activation transaction

Single controlled transaction with `pg_advisory_xact_lock(20200403)`:

1. Insert `WITHDRAWAL_REQUESTS_PAUSE` / `STAGING` / `enabled=true` + `feature_flag_versions` v1 (`old_enabled=NULL`, reason `PHASE20_CLOSED_BETA_WITHDRAWAL_REQUEST_PAUSE`, admin/audit NULL — Owner bootstrap).
2. Insert ACTIVE Risk v1 from canonical artifact.
3. Insert ACTIVE Trust v1 from canonical artifact.
4. Insert ACTIVE Eligibility v1 from canonical artifact.
5. Assert digests/configs, pause flags, AdsGram BLOCKED, no ledger/withdrawal/payout_publication mutation.
6. COMMIT.

**Result:** COMMITTED at `2026-10-02T04:53:08.065Z`.  
**Post-commit rollback required:** NO.

## Post-validation

| Check                                                | Result  |
| ---------------------------------------------------- | ------- |
| Risk zero → LOW / MANUAL_REVIEW                      | PASS    |
| OPEN_HIGH → 55 / HIGH / HELD                         | PASS    |
| OPEN_CRITICAL → 80 / CRITICAL / WITHDRAWAL_BLOCKED   | PASS    |
| CONFIRMED → 60 / HIGH / HELD                         | PASS    |
| Trust 0/25/50/75 → NEW/BASIC/ESTABLISHED/TRUSTED     | PASS    |
| AD ordinary → ELIGIBLE                               | PASS    |
| AD HIGH/CRITICAL → INELIGIBLE_RISK_POLICY            | PASS    |
| Withdrawal under pause → INELIGIBLE_FEATURE_DISABLED | PASS    |
| Founder bypass                                       | NO      |
| AdsGram monetary                                     | BLOCKED |
| Payout dispatch pause                                | true    |
| Withdrawal requests pause                            | true    |

## Gaps

| Gap         | Status                                                                    |
| ----------- | ------------------------------------------------------------------------- |
| P20-GAP-009 | REMEDIATED / OWNER_APPROVED / STAGING_ACTIVE / CONTROLLED_VALIDATION_PASS |
| P20-GAP-017 | OPEN / READY_FOR_OWNER_CONTENT_APPROVAL (unchanged)                       |

Blocker counts after closure: Closed Beta **1**, real-money **7**, archive **1**.

## Money safety (unchanged intent)

`LOOTRABOT_CANONICAL=true` · `APPLICATION_RUNTIME_LIVE=true` · `PRODUCTION_MONEY=false`  
No payout resume, no signer, no TON broadcast, no Mainnet, no AdsGram monetary enablement.

## Evidence artifacts

- `docs/phase20-step4c-activation-evidence.json`
- Activation tooling: `packages/fraud/scripts/phase20-step4c-owner-activation.mjs`

## Branch pointers

- `production-runtime` remains at RUNTIME_HEAD (runtime source only; evidence docs do not fast-forward it).
- Evidence/docs commits land on `phase20-closed-beta`.
