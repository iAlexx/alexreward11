# Phase 21 - Readiness Matrix (Step 3)

**PHASE21_GATE:** BLOCKED_FOR_MAINNET_PROVISIONING
**PHASE21_MAINNET_ENABLED:** NO (operational)
**PRODUCTION_SIGNER_SERVICE:** NOT_PROVISIONED
**SIGNER_HOSTING_DECISION:** DEDICATED_CONTROLLED_HOST
**CONTROLLED_MAINNET_WITHDRAWABLE_BALANCE_SOURCE:** SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED
**CANONICAL_RUNTIME:** production-runtime @ b9dd700 (unchanged; Phase21 not deployed)
**READY_FOR_LIVE_PAYOUT:** NO

Statuses: READY | PARTIAL | BLOCKED | NOT_PROVISIONED | OWNER_DECISION_REQUIRED

## Step 3 readiness distinctions

| Layer | Meaning | Step 3 default |
| --- | --- | --- |
| MAINNET_SOURCE_READY | Source foundations progressing / present | Approachable |
| READY_FOR_OWNER_PROVISIONING_CEREMONY | Foundations PASS; remaining blockers external/operational | Expected when defaults complete |
| READY_FOR_LIVE_PAYOUT | Live Mainnet payout authorization | **NO** (never from Step 3) |

```text
WORKER_MAINNET_SOURCE_WIRING=READY
WORKER_MAINNET_OPERATIONAL_ENABLE=OFF
SIGNER_HOSTING=DEDICATED_CONTROLLED_HOST
BALANCE_SOURCE=SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED
ATTACHED_GRAM_LIFECYCLE=ESTIMATED
FORWARD_GRAM_ATOMIC=1 (Owner-approved)
```

| ID | Requirement | Current state | Evidence / tooling | Readiness |
| --- | --- | --- | --- | --- |
| M01 | Phase 20 archived context preserved | Phase 20 PASS/ARCHIVED | Phase 20 acceptance/archive docs | READY (context) |
| M02 | Explicit Mainnet gate | Default false; operational OFF | PHASE21_MAINNET_ENABLED | BLOCKED (safe-off) |
| M03 | Network authority TON_MAINNET/-239 | Source support; chain=TON | phase21-config.ts | PARTIAL (code only) |
| M04 | Mainnet USDT Jetton master | Absent | TON_MAINNET_USDT_JETTON_MASTER | BLOCKED |
| M05 | Independent primary/secondary providers | Unconfigured | TON_PRIMARY_* / TON_SECONDARY_* | BLOCKED |
| M06 | Production signer service | Dedicated controlled host not deployed | ceremony + hosting decision | NOT_PROVISIONED |
| M07 | Signer self_hosted_encrypted + LOCKED boot | Policy ready; service absent | signing + config Phase21 path | BLOCKED |
| M08 | Hot Wallet registered/funded | Not created | Ceremony doc | BLOCKED |
| M09 | Initial exposure 5-10 USDT + GRAM gas | Not funded | assessPhase21InitialFundingExposure | BLOCKED |
| M10 | Real chain enable | false operationally | WITHDRAWAL_REAL_CHAIN_ENABLED | BLOCKED (safe-off) |
| M11 | Fake chain disabled | Default false | config | READY (safe) |
| M12 | Withdrawal request / payout pauses | Must stay paused until ceremony | readiness codes | PARTIAL (pause assumed; unpause forbidden) |
| M13 | Manual approval only / no auto payout/unpause/resend | Enforced in Phase21 config | phase21-config.ts | READY (source) |
| M14 | 50-withdrawal expansion gate | Implemented; count=0 | phase21-expansion-gate.ts | BLOCKED (count) |
| M15 | Withdrawable balance source | Tooling Owner-approved; not executed | SUPPORT_ADJUSTMENT path; ceiling 10_000_000 atomic USDT | SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED |
| M16 | Worker Mainnet **source** wiring | Implemented; default OFF | phase21-runtime-selection.ts, worker schema | READY (source) |
| M16b | Worker Mainnet **operational** enable | OFF — no live Mainnet dispatch | PHASE21_MAINNET_ENABLED=false operationally | BLOCKED (safe-off) |
| M17 | Signer hosting | Owner decision: DEDICATED_CONTROLLED_HOST | PHASE_21_SIGNER_HOSTING_DECISION.md | READY (decision) |
| M18 | Mainnet transfer gas policy | Forward 1 nanogram Owner-approved; attached ESTIMATED | jetton-transfer-policy.ts | PARTIAL (forward READY; attached OWNER_DECISION) |
| M19 | _(historical Step 2)_ Worker Mainnet wiring | Same as M16 — source READY / operational OFF | See M16 / M16b | READY (source) / BLOCKED (ops) |
| M20 | Mainnet Jetton external verification | Tooling present; live pending | phase21-external-probes.ts | BLOCKED |
| M21 | Signer hosting decision documented | DEDICATED_CONTROLLED_HOST | docs | READY (decision doc) |
| M22 | GRAM native currency naming | Display/canonical = Gram/GRAM; chain remains TON | PHASE_21_GRAM_NAMING_COMPATIBILITY.md | READY (docs) |
| M23 | Multichain wallet hardening | TON Connect Mainnet-only payout wallet | PHASE_21_MULTICHAIN_WALLET_COMPATIBILITY.md | READY (docs/source) |
| M24 | Offline Mainnet key ceremony tooling | Source ready; not executed | signer CLI + ceremony preflight | READY (tool) / BLOCKED (not run) |
| M25 | Dedicated signer deployment pack | Documented; not deployed | PHASE_21_PRODUCTION_RUNTIME_DEPLOYMENT_MANIFEST.md | READY (pack) / NOT_PROVISIONED |
| M26 | Controlled Available provision | Tooling present; disabled; not executed | PHASE_21_CONTROLLED_BALANCE_PROVISIONING.md | SOURCE_IMPLEMENTED / NOT_EXECUTED |
| M27 | AdsGram monetary gaps | Still OPEN | PHASE_21_REAL_MONEY_BLOCKER_MAPPING.md | BLOCKED (gaps OPEN) |
| M28 | Micro-launch band math | 50 x 0.20 gross=10.00; net 9.50 @ 0.01 fee | docs | READY (documented) |

CLI: `pnpm phase21:readiness` / `pnpm phase21:preflight` - overall readiness BLOCKED; preflight may reach `READY_FOR_OWNER_PROVISIONING_CEREMONY` when source foundations complete and remaining items are external. Never `READY_FOR_LIVE_PAYOUT`. No live payout from Step 3.

## Step 3A source corrections (must PASS before ceremony readiness)

| Code | Meaning |
| --- | --- |
| CONTROLLED_PROVISION_OPERATIONAL_MODE | Test vs production ceremony env gates |
| LIVE_FEE_ESTIMATOR_HONEST | MOCK / LIVE_READ_ONLY / UNAVAILABLE honesty |
| PRODUCTION_ENV_CUTOVER_PLAN | Cutover docs present; not executed |
| EXTERNAL_VERIFIER_HARDENED | Provider independence + provenance |
| WITHDRAWAL_REQUEST_PAUSE_FAIL_CLOSED | Missing pause row fails closed |
| PRODUCTION_FLAG_BASELINE_TOOL | DRY_RUN baseline tooling present |
| MAINNET_REGISTRY_BOOTSTRAP | DRY_RUN registry bootstrap present |

READY_FOR_LIVE_PAYOUT remains always false.

## Step 3B ceremony tooling hardening (source observations)

| Code | Meaning |
| --- | --- |
| FORCE_APPLY_REMOVED | No forceApply bypass; env gates only |
| PRODUCTION_FLAG_BASELINE_ATOMIC | Atomic flag baseline APPLY |
| MAINNET_REGISTRY_ONE_PASS_ATOMIC | Zero→complete registry one txn |
| CONCRETE_EXTERNAL_ADAPTERS | Toncenter/TonAPI Mainnet read-only adapters |
| CONCRETE_FEE_ADAPTER | Toncenter Mainnet fee provider |
| HOT_WALLET_REGISTRATION_TOOL | Gated hot wallet register tooling |

READY_FOR_LIVE_PAYOUT remains false.
