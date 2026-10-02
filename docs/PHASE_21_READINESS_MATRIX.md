# Phase 21 — Readiness Matrix (Step 1)

**PHASE21_GATE:** `BLOCKED_FOR_MAINNET_PROVISIONING`
**PHASE21_MAINNET_ENABLED:** `NO`
**PRODUCTION_SIGNER_SERVICE:** `NOT_PROVISIONED`
**CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE:** `BLOCKED_OWNER_DECISION`

Statuses: `READY` | `PARTIAL` | `BLOCKED` | `NOT_PROVISIONED` | `OWNER_DECISION_REQUIRED`

| ID | Requirement | Current state | Evidence / tooling | Readiness |
| --- | --- | --- | --- | --- |
| M01 | Phase 20 archived context preserved | Phase 20 PASS/ARCHIVED | Phase 20 acceptance/archive docs | READY (context) |
| M02 | Explicit Mainnet gate | Default false | `PHASE21_MAINNET_ENABLED` / `phase21MainnetEnabled` | BLOCKED (safe-off) |
| M03 | Network authority TON_MAINNET/-239 | Source support only | `phase21-config.ts` | PARTIAL (code only) |
| M04 | Mainnet USDT Jetton master | Absent | `TON_MAINNET_USDT_JETTON_MASTER` | BLOCKED |
| M05 | Independent primary/secondary providers | Unconfigured | `TON_PRIMARY_*` / `TON_SECONDARY_*` | BLOCKED |
| M06 | Production signer service | Not on Railway | Ceremony doc | NOT_PROVISIONED |
| M07 | Signer self_hosted_encrypted + LOCKED boot | Policy ready; service absent | signing + config Phase21 path | BLOCKED |
| M08 | Hot Wallet registered/funded | Not created | Ceremony doc | BLOCKED |
| M09 | Initial exposure 5–10 USDT + gas | Not funded | `assessPhase21InitialFundingExposure` | BLOCKED |
| M10 | Real chain enable | false | `WITHDRAWAL_REAL_CHAIN_ENABLED` | BLOCKED |
| M11 | Fake chain disabled | Default false | config | READY (safe) |
| M12 | Withdrawal request / payout pauses | Must stay paused until ceremony | readiness codes | PARTIAL (pause assumed; unpause forbidden) |
| M13 | Manual approval only / no auto payout/unpause/resend | Enforced in Phase21 config | `phase21-config.ts` | READY (source) |
| M14 | 50-withdrawal expansion gate | Implemented; count=0 | `phase21-expansion-gate.ts` | BLOCKED (count) |
| M15 | Withdrawable balance source | Owner decision required | blocker mapping | OWNER_DECISION_REQUIRED |
| M16 | Worker live Mainnet dispatch | Not wired (schema still refuses MAINNET) | `packages/config` workerSchema comment | BLOCKED |
| M17 | Railway signer hosting suitability | Potential architectural blocker (loopback unlock / public exposure) | ceremony doc | OWNER_DECISION_REQUIRED |

CLI: `pnpm phase21:readiness` / `pnpm phase21:preflight` — expect BLOCKED in Step 1.
